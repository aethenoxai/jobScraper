/**
 * Backups of everything Job Scraper keeps (PLAN M9): the database, taken with SQLite's online backup so it is
 * consistent even while the worker writes, and the files folder (CVs, tailored documents). `.env` is never included.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export const BACKUPS_KEEP = 10;
/** Pre-upgrade snapshots and data set aside by restores are kept in smaller numbers. */
const KEEP_BY_KIND = { 'pre-migration': 5, replaced: 10 } as const;

/** "other": a folder copied into data/backups by the user; listed, never pruned. */
export type BackupKind = 'backup' | 'pre-migration' | 'replaced' | 'other';
const LABELS: Record<BackupKind, string> = { backup: 'backup (database and files)', 'pre-migration': 'before an upgrade (database only)', replaced: 'data replaced by a restore', other: 'copied in by you' };

/** A new folder under data/backups: `<prefix>-<time>`, with -2, -3… if one with that name exists (same second). */
export function newBackupDir(dataDir: string, prefix: string, at: Date): string {
  const base = path.join(dataDir, 'backups', `${prefix}-${backupStamp(at)}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

export interface BackupPaths {
  dataDir: string;
  dbPath: string;
  filesDir: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Folder-name time in the user's own time zone: 2026-10-01_14-05-09. */
export const backupStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

export async function createBackup(opts: BackupPaths & { sqlite: Database.Database; now?: () => Date; keep?: number; prefix?: string }): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const dir = newBackupDir(opts.dataDir, opts.prefix ?? 'backup', now());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await opts.sqlite.backup(path.join(dir, 'job-scraper.db'));
  if (process.platform !== 'win32') chmodSync(path.join(dir, 'job-scraper.db'), 0o600);
  if (existsSync(opts.filesDir)) cpSync(opts.filesDir, path.join(dir, 'files'), { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: now().toISOString(), kind: opts.prefix ?? 'backup' }, null, 2));
  pruneBackups(opts.dataDir, opts.keep ?? BACKUPS_KEEP);
  return dir;
}

export function listBackups(dataDir: string): Array<{ name: string; dir: string; createdAt: Date; kind: BackupKind; label: string }> {
  const root = path.join(dataDir, 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((name) => {
      const dir = path.join(root, name);
      let createdAt: Date;
      try {
        createdAt = statSync(dir).mtime;
      } catch {
        return []; // a broken entry (e.g. a dangling link) is not a backup
      }
      try {
        createdAt = new Date(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).createdAt);
      } catch {}
      const kind: BackupKind = name.startsWith('pre-migration-') ? 'pre-migration' : name.startsWith('replaced-') ? 'replaced' : name.startsWith('backup-') ? 'backup' : 'other';
      return [{ name, dir, createdAt, kind, label: LABELS[kind] }];
    })
    .filter((b) => existsSync(path.join(b.dir, 'job-scraper.db')))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Keeps the newest of each kind; each kind rotates separately so one doesn't push out another. */
export function pruneBackups(dataDir: string, keep: number = BACKUPS_KEEP): void {
  const limits = { backup: keep, ...KEEP_BY_KIND };
  for (const kind of Object.keys(limits) as Array<keyof typeof limits>) {
    const all = listBackups(dataDir).filter((b) => b.kind === kind);
    for (const old of all.slice(limits[kind])) rmSync(old.dir, { recursive: true, force: true });
  }
}

/**
 * Restores a backup over the current data (Job Scraper must be stopped). The replaced database and files are kept
 * aside in data/backups/replaced-<time> so a mistaken restore can be undone. Returns that folder.
 */
export function restoreBackup(backupDir: string, p: BackupPaths, now: () => Date = () => new Date()): string {
  if (path.resolve(backupDir, 'job-scraper.db') === path.resolve(p.dbPath)) throw new Error(`${backupDir} is the data folder itself, not a backup. Pick a folder from data/backups (pnpm restore lists them).`);
  if (!existsSync(path.join(backupDir, 'job-scraper.db'))) throw new Error(`${backupDir} is not a Job Scraper backup`);
  const aside = newBackupDir(p.dataDir, 'replaced', now());
  mkdirSync(aside, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(p.dbPath + suffix)) renameSync(p.dbPath + suffix, path.join(aside, `job-scraper.db${suffix}`));
  // A database-only backup (the snapshot taken before an upgrade) leaves the current files in place.
  const withFiles = existsSync(path.join(backupDir, 'files'));
  if (withFiles && existsSync(p.filesDir)) renameSync(p.filesDir, path.join(aside, 'files'));
  cpSync(path.join(backupDir, 'job-scraper.db'), p.dbPath);
  if (withFiles) cpSync(path.join(backupDir, 'files'), p.filesDir, { recursive: true });
  writeFileSync(path.join(aside, 'manifest.json'), JSON.stringify({ createdAt: now().toISOString(), kind: 'replaced' }, null, 2));
  pruneBackups(p.dataDir);
  return aside;
}
