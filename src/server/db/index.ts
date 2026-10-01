import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { newBackupDir, pruneBackups } from '../backup';

export type Db = BetterSQLite3Database;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

/** Whether an existing database has migrations still to apply (it then gets a snapshot first). */
function pendingMigrations(sqlite: Database.Database, migrationsDir: string): boolean {
  const table = sqlite.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  if (!table) return false; // a new database: nothing to protect
  const applied = (sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n;
  const journal = JSON.parse(readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
  return journal.entries.length > applied;
}

/**
 * Web and worker start together and both open (and migrate) the database. Opening is serialised across processes
 * with an exclusive lock on a separate small file, so the second one waits and then finds nothing left to do.
 */
function withOpenLock<T>(file: string, fn: () => T): T {
  const lock = new Database(`${file}.open-lock`);
  try {
    lock.pragma('busy_timeout = 60000');
    lock.exec('BEGIN EXCLUSIVE');
    try {
      return fn();
    } finally {
      lock.exec('COMMIT');
    }
  } finally {
    lock.close();
  }
}

export function openDb(file: string, opts: { migrationsDir?: string } = {}): DbHandle {
  // The data folder holds the CV, tokens and sessions: readable only by the user (a new folder; an existing one is
  // left as the user set it, but the database itself is tightened below).
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A folder an older version created as 0755: closing it to others protects every file inside.
  if (process.platform !== 'win32' && path.resolve(path.dirname(file)) !== path.resolve(homedir())) {
    try {
      chmodSync(path.dirname(file), 0o700);
    } catch {
      // Not ours to change (another owner): leave it.
    }
  }
  return withOpenLock(file, () => openUnlocked(file, opts));
}

function openUnlocked(file: string, opts: { migrationsDir?: string }): DbHandle {
  const existed = existsSync(file);
  const sqlite = new Database(file);
  // SQLite creates its -wal and -shm files with the database's permissions.
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  sqlite.pragma('busy_timeout = 5000');
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  if (existed && pendingMigrations(sqlite, migrationsDir)) {
    // A consistent snapshot of the database before its schema changes (VACUUM INTO is synchronous and safe while open).
    const at = new Date();
    const dir = newBackupDir(path.dirname(file), 'pre-migration', at);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sqlite.prepare('VACUUM INTO ?').run(path.join(dir, 'job-scraper.db'));
    if (process.platform !== 'win32') chmodSync(path.join(dir, 'job-scraper.db'), 0o600);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: at.toISOString(), kind: 'pre-migration' }, null, 2));
    try {
      pruneBackups(path.dirname(file));
    } catch {
      // Tidying old snapshots must never stop the app from starting.
    }
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle({ client: sqlite });
  // Migrations that rebuild a table (DROP + RENAME) must not cascade-delete child rows, and SQLite ignores this
  // pragma inside the migration transaction, so foreign keys are switched off around the whole migration run.
  sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: migrationsDir });
    const broken = sqlite.pragma('foreign_key_check') as unknown[];
    if (broken.length) throw new Error(`Database migration left ${broken.length} broken references; restore data/backups and report a bug.`);
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  return { db, sqlite, close: () => sqlite.close() };
}
