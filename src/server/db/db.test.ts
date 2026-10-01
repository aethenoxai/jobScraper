import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './index';

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'job-scraper-db-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('openDb', () => {
  it('creates missing directories and applies migrations', () => {
    const file = path.join(tempDir(), 'nested', 'deeper', 'job-scraper.db');
    const { sqlite, close } = openDb(file);
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['settings', 'queue_tasks', 'scan_runs', 'profiles', 'master_cvs', 'ai_usage', 'sources', 'source_runs', 'jobs', 'job_listings', 'job_analyses', 'matches', 'applications', 'application_events', 'notifications', 'documents', 'sent_emails', 'inbox_messages']));
    expect(existsSync(file)).toBe(true);
    close();
  });

  it('enables WAL, foreign keys and a busy timeout', () => {
    const { sqlite, close } = openDb(path.join(tempDir(), 'a.db'));
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    close();
  });

  it('is safe to open the same database twice in a row', () => {
    const file = path.join(tempDir(), 'b.db');
    openDb(file).close();
    const { sqlite, close } = openDb(file);
    expect(sqlite.prepare('select count(*) as n from settings').get()).toEqual({ n: 0 });
    close();
  });
});

describe.skipIf(process.platform === 'win32')('database file permissions', () => {
  it('a new data folder and database are readable only by you (also an existing database)', () => {
    const dataDir = path.join(tempDir(), 'data');
    const h = openDb(path.join(dataDir, 'job-scraper.db'));
    h.close();
    expect(statSync(dataDir).mode & 0o077).toBe(0);
    expect(statSync(path.join(dataDir, 'job-scraper.db')).mode & 0o077).toBe(0);
  });

  it('tightens a data folder an older version created readable by others', () => {
    const dataDir = path.join(tempDir(), 'old-data');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    openDb(path.join(dataDir, 'job-scraper.db')).close();
    expect(statSync(dataDir).mode & 0o077).toBe(0);
  });
});

describe('two processes starting at the same moment (web and worker)', () => {
  /** Starts `n` real processes that open (and so migrate) the same new database at the same millisecond. */
  async function raceOpen(file: string, n: number): Promise<Array<{ code: number | null; stderr: string }>> {
    const startAt = Date.now() + 1500;
    const code = `const { openDb } = await import(${JSON.stringify(path.resolve('src/server/db/index.ts'))}); while (Date.now() < ${startAt}); const h = openDb(${JSON.stringify(file)}); h.close();`;
    return Promise.all(
      Array.from({ length: n }, () =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd() });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += d));
          child.on('close', (c) => resolve({ code: c, stderr }));
        }),
      ),
    );
  }

  it('never fails to start because the other one is migrating the same database', async () => {
    for (let round = 0; round < 3; round++) {
      const file = path.join(tempDir(), `race-${round}.db`);
      const results = await raceOpen(file, 3);
      expect(results.map((r) => (r.code === 0 ? 'ok' : r.stderr.split('\n').find((l) => /Error/.test(l)) ?? `exit ${r.code}`))).toEqual(['ok', 'ok', 'ok']);
    }
  }, 60_000);
});

describe('migrations that rebuild tables', () => {
  it('keep child rows (no cascade) and fill application snapshots', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const { default: Database } = await import('better-sqlite3');
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    const { readdirSync, mkdirSync, copyFileSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'js-mig-'));
    // Migrate to just before the applications rebuild (0006), insert data, then run the rest via openDb.
    const partial = path.join(dir, 'partial');
    mkdirSync(path.join(partial, 'meta'), { recursive: true });
    const journal = JSON.parse((await import('node:fs')).readFileSync('drizzle/meta/_journal.json', 'utf8'));
    const upTo = journal.entries.filter((e: { idx: number }) => e.idx <= 6);
    for (const e of upTo) copyFileSync(`drizzle/${e.tag}.sql`, path.join(partial, `${e.tag}.sql`));
    (await import('node:fs')).writeFileSync(path.join(partial, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: upTo }));
    void readdirSync;
    const file = path.join(dir, 'db.sqlite');
    const raw = new Database(file);
    migrate(drizzle({ client: raw }), { migrationsFolder: partial });
    raw.exec(`insert into profiles (name,is_default,data,preferences,slider_value,user_edited,created_at,updated_at) values ('p',1,'{}','{}',100,0,0,0);
      insert into sources (adapter_id,name,enabled,config,origin,consecutive_failures,created_at) values ('greenhouse','Acme careers',1,'{}','user',0,0);
      insert into jobs (fingerprint,company_key,title,company,status,first_seen_at,last_seen_at,last_changed_at) values ('f','acme','Engineer','Acme','active',0,0,0);
      insert into job_listings (job_id,source_id,source_job_id,source_url,title,company,description,description_hash,status,missed_runs,first_seen_at,last_seen_at,last_changed_at) values (1,1,'1','https://x/1','Engineer','Acme','d','h','active',0,0,0,0);
      insert into applications (profile_id,job_id,listing_id,method,status,approved_at,created_at,updated_at) values (1,1,1,'browser','READY',0,0,0);
      insert into application_events (application_id,type,origin,message,occurred_at) values (1,'approved','user','ok',0);`);
    raw.close();
    const { sqlite, close } = openDb(file);
    expect(sqlite.prepare('select count(*) as n from application_events').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('select job_title, company, source_name, source_url from applications').get()).toEqual({ job_title: 'Engineer', company: 'Acme', source_name: 'Acme careers', source_url: 'https://x/1' });
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    close();
    rmSync(dir, { recursive: true, force: true });
  });
});
