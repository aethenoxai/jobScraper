import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupStamp, createBackup, listBackups, pruneBackups, restoreBackup } from './backup';
import { MIGRATIONS_DIR, openDb } from './db';

let dir = '';
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'js-backup-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const paths = () => ({ dataDir: dir, dbPath: path.join(dir, 'job-scraper.db'), filesDir: path.join(dir, 'files') });

describe('backups', () => {
  it('copies the database (consistently, while open) and the files, and keeps the newest ten', async () => {
    const p = paths();
    const { sqlite, close } = openDb(p.dbPath);
    sqlite.prepare("insert into settings (key, value, updated_at) values ('k', '\"v\"', 1)").run();
    mkdirSync(path.join(p.filesDir, 'applications', '1'), { recursive: true });
    writeFileSync(path.join(p.filesDir, 'applications', '1', 'cv.pdf'), '%PDF');
    let t = 1_700_000_000_000;
    for (let i = 0; i < 12; i++) await createBackup({ ...p, sqlite, now: () => new Date((t += 60_000)) });
    close();
    const backups = listBackups(p.dataDir);
    expect(backups).toHaveLength(10);
    const latest = backups[0];
    expect(readFileSync(path.join(latest.dir, 'files', 'applications', '1', 'cv.pdf'), 'utf8')).toBe('%PDF');
    const copy = openDb(path.join(latest.dir, 'job-scraper.db'));
    expect(copy.sqlite.prepare("select value from settings where key = 'k'").get()).toEqual({ value: '"v"' });
    copy.close();
    expect(existsSync(path.join(p.dataDir, '.env'))).toBe(false);
  });

  it('restores a backup, keeping the replaced data aside', async () => {
    const p = paths();
    const h = openDb(p.dbPath);
    h.sqlite.prepare("insert into settings (key, value, updated_at) values ('k', '\"before\"', 1)").run();
    mkdirSync(p.filesDir, { recursive: true });
    writeFileSync(path.join(p.filesDir, 'a.txt'), 'before');
    const backup = await createBackup({ ...p, sqlite: h.sqlite, now: () => new Date(1_700_000_000_000) });
    h.sqlite.prepare("update settings set value = '\"after\"' where key = 'k'").run();
    writeFileSync(path.join(p.filesDir, 'a.txt'), 'after');
    h.close();
    const aside = restoreBackup(backup, p, () => new Date(1_700_000_100_000));
    const r = openDb(p.dbPath);
    expect(r.sqlite.prepare("select value from settings where key = 'k'").get()).toEqual({ value: '"before"' });
    r.close();
    expect(readFileSync(path.join(p.filesDir, 'a.txt'), 'utf8')).toBe('before');
    expect(existsSync(aside)).toBe(true);
  });

  it('restoring a database-only snapshot leaves the files where they are (final review, ops I2)', () => {
    const p = paths();
    openDb(p.dbPath).close();
    mkdirSync(p.filesDir, { recursive: true });
    writeFileSync(path.join(p.filesDir, 'cv.pdf'), 'my cv');
    const snapshot = path.join(dir, 'backups', 'pre-migration-x');
    mkdirSync(snapshot, { recursive: true });
    cpSync(p.dbPath, path.join(snapshot, 'job-scraper.db'));
    restoreBackup(snapshot, p);
    expect(readFileSync(path.join(p.filesDir, 'cv.pdf'), 'utf8')).toBe('my cv');
  });

  it('takes a snapshot automatically before migrating an existing database', () => {
    const p = paths();
    // An older install: only the first migrations exist.
    const old = path.join(dir, 'old-migrations');
    cpSync(MIGRATIONS_DIR, old, { recursive: true });
    const journal = JSON.parse(readFileSync(path.join(old, 'meta', '_journal.json'), 'utf8'));
    for (const e of journal.entries.slice(3)) rmSync(path.join(old, `${e.tag}.sql`));
    journal.entries = journal.entries.slice(0, 3);
    writeFileSync(path.join(old, 'meta', '_journal.json'), JSON.stringify(journal));
    openDb(p.dbPath, { migrationsDir: old }).close();
    expect(existsSync(path.join(dir, 'backups'))).toBe(false);
    openDb(p.dbPath).close();
    const snaps = readdirSync(path.join(dir, 'backups'));
    expect(snaps.some((s) => s.startsWith('pre-migration-'))).toBe(true);
    // Up to date: no new snapshot.
    openDb(p.dbPath).close();
    expect(readdirSync(path.join(dir, 'backups'))).toHaveLength(snaps.length);
  });

  it('names backups in local time and says what each folder is, keeping a few of each kind (final review, ops/new-user minors)', async () => {
    const p = paths();
    const at = new Date(2026, 9, 1, 14, 5, 9);
    expect(backupStamp(at)).toBe('2026-10-01_14-05-09');
    const h = openDb(p.dbPath);
    await createBackup({ ...p, sqlite: h.sqlite, now: () => at });
    h.close();
    for (let i = 0; i < 6; i++) {
      for (const kind of ['pre-migration']) {
        const d = path.join(dir, 'backups', `${kind}-2026-09-0${i + 1}_10-00-00`);
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, 'job-scraper.db'), '');
        writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ createdAt: new Date(2026, 8, i + 1).toISOString() }));
      }
    }
    pruneBackups(p.dataDir);
    const all = listBackups(p.dataDir);
    expect(all.filter((b) => b.kind === 'pre-migration')).toHaveLength(5);
    expect(all[0]).toMatchObject({ name: 'backup-2026-10-01_14-05-09', kind: 'backup', label: 'backup (database and files)' });
    expect(all.find((b) => b.kind === 'pre-migration')?.label).toBe('before an upgrade (database only)');
  });

  it('never overwrites or prunes a folder it doesn’t own, and refuses to restore the data folder onto itself (round 2)', async () => {
    const p = paths();
    const at = new Date(2026, 9, 1, 14, 5, 9);
    const h = openDb(p.dbPath);
    const first = await createBackup({ ...p, sqlite: h.sqlite, now: () => at });
    const second = await createBackup({ ...p, sqlite: h.sqlite, now: () => at });
    h.close();
    expect(second).not.toBe(first);
    expect(existsSync(path.join(first, 'job-scraper.db')) && existsSync(path.join(second, 'job-scraper.db'))).toBe(true);
    // A backup copied back in under its own name is the user's: listed, never pruned.
    const mine = path.join(dir, 'backups', 'my-copy-before-moving');
    cpSync(first, mine, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const aside = path.join(dir, 'backups', `replaced-2026-09-${String(i + 1).padStart(2, '0')}_10-00-00`);
      mkdirSync(aside, { recursive: true });
      writeFileSync(path.join(aside, 'job-scraper.db'), '');
    }
    pruneBackups(p.dataDir);
    expect(existsSync(mine)).toBe(true);
    expect(listBackups(p.dataDir).find((b) => b.dir === mine)?.label).toBe('copied in by you');
    expect(listBackups(p.dataDir).filter((b) => b.kind === 'replaced')).toHaveLength(10);
    expect(() => restoreBackup(p.dataDir, p)).toThrow(/data folder itself/);
    expect(existsSync(p.dbPath)).toBe(true);
  });

  it('a broken entry in data/backups never stops the app from starting or the list from showing (round 3)', () => {
    const p = paths();
    openDb(p.dbPath).close();
    mkdirSync(path.join(dir, 'backups'), { recursive: true });
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'backups', 'backup-dangling'));
    expect(() => listBackups(p.dataDir)).not.toThrow();
    expect(() => pruneBackups(p.dataDir)).not.toThrow();
  });
});
