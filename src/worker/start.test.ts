import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../../tests/helpers/wait-for';
import { loadConfig, type Config } from '@/server/config';
import { openDb } from '@/server/db';
import { createLogger } from '@/server/logging';
import { createQueue } from '@/server/queue';
import { listRecentScanRuns } from '@/server/scans';
import { createScheduler, SCAN_TASK } from '@/server/scheduler';
import { createSettings } from '@/server/settings';
import { HEARTBEAT_KEY, HeartbeatSchema } from '@/server/status/heartbeat';
import { readFileSync } from 'node:fs';
import { createCvService } from '@/server/profile/cv-service';
import { createProfileService } from '@/server/profile/service';
import { createFileStore } from '@/server/storage';
import { updateOnboarding } from '@/server/onboarding';
import { readScraplingStatus } from '@/server/scrapling/status';
import { startWorker, WorkerAlreadyRunningError } from './start';

const log = createLogger({ level: 'silent' });
const fast = { pollMs: 10, schedulerTickMs: 10, heartbeatMs: 50, log, seedDefaultSources: false };

/** A finished onboarding: a profile exists and Start was pressed (scans are refused before that). */
function onboard(dbPath: string) {
  const h = openDb(dbPath);
  const profiles = createProfileService({ db: h.db, files: createFileStore(path.join(path.dirname(dbPath), 'files')) });
  const p = profiles.create('Main profile');
  updateOnboarding(createSettings(h.db), (s) => ({ ...s, profileId: p.id, aiVerifiedAt: 1, profileConfirmedAt: 1, preferencesConfirmedAt: 1, completedAt: 1 }));
  h.close();
}
let dir: string;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-worker-'));
  config = loadConfig({ DATA_DIR: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('startWorker', () => {
  it('runs scheduled scans once the user starts discovery', async () => {
    onboard(config.dbPath);
    const worker = await startWorker({ config, ...fast });
    const web = openDb(config.dbPath);
    createScheduler({ settings: createSettings(web.db), queue: createQueue(web.db) }).start();
    const runs = await waitFor(() => {
      const r = listRecentScanRuns(web.db);
      // No sources are on in this test, so a scan that ran ends as "skipped" (nothing to check).
      return r.length > 0 && r[0].status !== 'running' ? r : null;
    });
    expect(runs[0].trigger).toBe('schedule');
    await worker.stop();
    web.close();
  });

  it('refuses to start while another live worker holds the heartbeat', async () => {
    const db = openDb(config.dbPath);
    createSettings(db.db).set(HEARTBEAT_KEY, { workerId: 'other', pid: 424242, at: Date.now() });
    db.close();
    await expect(startWorker({ config, ...fast, isAlive: () => true })).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
  });

  it('refuses a second worker even from the same process (no check-then-write race)', async () => {
    const first = await startWorker({ config, ...fast });
    await expect(startWorker({ config, ...fast })).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    await first.stop();
    const again = await startWorker({ config, ...fast });
    await again.stop();
  });

  it('starts after a container restart, when the dead worker had the same pid as this one (Docker)', async () => {
    const db = openDb(config.dbPath);
    createSettings(db.db).set(HEARTBEAT_KEY, { workerId: 'worker-before-restart', pid: process.pid, at: Date.now() });
    db.close();
    const worker = await startWorker({ config, ...fast });
    await worker.stop();
  });

  it('starts when the previous heartbeat is stale or its process is dead', async () => {
    const db = openDb(config.dbPath);
    createSettings(db.db).set(HEARTBEAT_KEY, { workerId: 'other', pid: 424242, at: Date.now() });
    db.close();
    const worker = await startWorker({ config, ...fast, isAlive: () => false });
    await worker.stop();
  });

  it('searches nothing before onboarding, even with a schedule switched on and a scan queued', async () => {
    const db = openDb(config.dbPath);
    createSettings(db.db).set('scheduler', { enabled: true, intervalMinutes: 60, lastTriggeredAt: null, nextRunAt: Date.now() });
    createQueue(db.db).enqueue(SCAN_TASK, { trigger: 'manual' });
    db.close();
    const worker = await startWorker({ config, ...fast });
    const check = openDb(config.dbPath);
    await waitFor(() => (createQueue(check.db).counts().done === 1 ? true : null));
    await new Promise((r) => setTimeout(r, 100)); // several scheduler ticks
    expect(listRecentScanRuns(check.db)).toHaveLength(0);
    expect(createQueue(check.db).counts().pending).toBe(0);
    await worker.stop();
    check.close();
  });

  it('recovers a task interrupted by a crash', async () => {
    onboard(config.dbPath);
    const db = openDb(config.dbPath);
    const queue = createQueue(db.db);
    queue.enqueue(SCAN_TASK, { trigger: 'manual' });
    queue.claim('crashed-worker'); // left "running" forever by a dead process
    db.close();

    const worker = await startWorker({ config, ...fast });
    const check = openDb(config.dbPath);
    await waitFor(() => listRecentScanRuns(check.db).find((r) => r.status === 'skipped' || r.status === 'success'));
    expect(createQueue(check.db).counts()).toMatchObject({ running: 0, done: 1 });
    await worker.stop();
    check.close();
  });

  it('marks its heartbeat stale on stop', async () => {
    const worker = await startWorker({ config, ...fast });
    await worker.stop();
    const db = openDb(config.dbPath);
    const hb = createSettings(db.db).get(HEARTBEAT_KEY, HeartbeatSchema.nullable(), null);
    expect(hb?.at).toBe(0);
    db.close();
  });

  it('extracts an uploaded CV into the profile in the background', async () => {
    const web = openDb(config.dbPath);
    const files = createFileStore(config.filesDir);
    const profiles = createProfileService({ db: web.db, files });
    const cvs = createCvService({ db: web.db, files, queue: createQueue(web.db), profiles, ai: null, log });
    const p = profiles.create('Nurse');
    const cv = await cvs.upload(p.id, 'cv.pdf', readFileSync(path.resolve('tests/fixtures/cvs/files/nurse-uk.pdf')));
    const worker = await startWorker({ config, ...fast });
    await waitFor(() => cvs.get(cv.id)?.status === 'applied', 10_000);
    expect(profiles.get(p.id)?.data.personal.fullName).toBe('Olivia Bennett');
    await worker.stop();
    web.close();
  }, 15_000);
});

describe('startWorker and Scrapling', () => {
  it('checks Scrapling at start and records the result for the System page', async () => {
    const worker = await startWorker({ config, ...fast, env: { SCRAPLING_PYTHON: path.join(dir, 'no-such-python') } });
    const h = openDb(config.dbPath);
    try {
      const settings = createSettings(h.db);
      await vi.waitFor(() => expect(readScraplingStatus(settings)).toMatchObject({ ready: false, error: expect.stringMatching(/pnpm run setup/) }));
    } finally {
      await worker.stop();
      h.close();
    }
  });
});
