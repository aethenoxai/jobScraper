/**
 * Crash-recovery drill (PLAN M9 Task 1): the database is left exactly as `kill -9` leaves it in the middle of every
 * kind of work, then a fresh worker starts. It must reach a consistent state on its own: no scan, preparation or
 * application stuck "in progress", no email left "sending", interrupted work resumed, and nothing sent twice.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_TASK, createApplicationService, EMAIL_TASK } from '@/server/applications/service';
import type { BrowserEngine } from '@/server/browser/engine';
import { loadConfig, type Config } from '@/server/config';
import { openDb } from '@/server/db';
import { applications, queueTasks, scanRuns, sentEmails, sources } from '@/server/db/schema';
import { createIngestor } from '@/server/jobs/ingest';
import { createLogger } from '@/server/logging';
import { createMatchService, PREPARE_TASK } from '@/server/matching/service';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '@/server/profile/model';
import { createProfileService } from '@/server/profile/service';
import { createQueue } from '@/server/queue';
import { SCAN_TASK } from '@/server/scheduler';
import { createFileStore } from '@/server/storage';
import { startWorker } from '@/worker/start';
import { waitFor } from './helpers/wait-for';

const log = createLogger({ level: 'silent' });
const fast = { pollMs: 10, schedulerTickMs: 10, heartbeatMs: 50, log, seedDefaultSources: false };
const pdf = { render: async () => Buffer.from('%PDF-1.7 drill'), close: async () => {} };
let browserOpened = 0;
const noBrowser: BrowserEngine = {
  withPage: async () => {
    browserOpened++;
    throw new Error('No browser in the recovery drill');
  },
  openForSignIn: async () => {},
};

let dir: string;
let config: Config;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-drill-'));
  config = loadConfig({ DATA_DIR: dir });
  browserOpened = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Leaves the database the way a worker killed mid-task leaves it. Returns the application ids by situation. */
async function crashMidWork() {
  const handle = openDb(config.dbPath);
  const db = handle.db;
  const files = createFileStore(config.filesDir);
  const queue = createQueue(db);
  const profiles = createProfileService({ db, files });
  const matching = createMatchService({ db, ai: null, queue, profiles, log });
  const apps = createApplicationService({ db, files, queue, profiles });

  const p = profiles.create('Engineer');
  const d = emptyProfile();
  d.personal = { fullName: 'Asha Rao', email: 'asha@example.com', phone: null, location: 'Pune, India', country: 'India', timezone: null, links: [] };
  d.headline = 'Backend Engineer';
  d.skills = [{ id: '', name: 'Go', category: 'technology' }];
  d.experience = [{ id: '', title: 'Backend Engineer', company: 'Example Payments', location: null, startDate: '2021-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built Go services' }] }];
  profiles.updateData(p.id, assignIds(d), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  const src = db.insert(sources).values({ adapterId: 'manual', name: 'Pasted', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const listings = ['prep', 'email', 'clicked', 'browser'].map((k) => ({ sourceJobId: k, sourceUrl: `https://jobs.example.test/${k}`, applicationUrl: `https://jobs.example.test/${k}/apply`, title: 'Backend Engineer', company: `Acme ${k}`, location: 'Pune, India', description: 'Requirements\n• Go' }));
  const jobIds = createIngestor({ db }).ingestRun(src, listings, { completeSnapshot: false }).changedJobIds;
  const [prep, email, clicked, browser] = await Promise.all(jobIds.map(async (jobId) => matching.approve((await matching.evaluate(jobId, p.id)).matchId)));

  // The preparation of `prep` was running when the worker died; the others had finished preparing.
  queue.claim('dead-worker', [PREPARE_TASK]);
  for (let i = 0; i < 3; i++) queue.complete(queue.claim('w', [PREPARE_TASK])!.id);
  for (const a of [email, clicked, browser]) {
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    await apps.saveDocument(a.id, 'tailored_cv_pdf', 'CV.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
  }

  // Killed while the SMTP server was being called: the attempt row says "sending".
  apps.transition(email.id, 'APPLYING', { origin: 'user', message: 'Sending' });
  db.update(applications).set({ method: 'email' }).where(eq(applications.id, email.id)).run();
  apps.recordEmailAttempt({ applicationId: email.id, messageId: '<drill@example.com>', provider: 'smtp', fromAddress: 'asha@example.com', toAddress: 'jobs@acme.example', subject: 'Application', body: 'Hello', attachments: [] });
  queue.enqueue(EMAIL_TASK, { applicationId: email.id });
  queue.claim('dead-worker', [EMAIL_TASK]);

  // Killed right after clicking Submit on the website, and before reaching Submit.
  for (const a of [clicked, browser]) {
    apps.applyInBrowser(a.id);
    queue.claim('dead-worker', [BROWSER_TASK]);
  }
  apps.addEvent(clicked.id, 'browser_submit_clicked', 'system', 'Submitted the application form', { site: 'jobs.example.test' });

  // Killed in the middle of a scan.
  db.insert(scanRuns).values({ trigger: 'manual', status: 'running', startedAt: new Date() }).run();
  queue.enqueue(SCAN_TASK, { trigger: 'manual' });
  queue.claim('dead-worker', [SCAN_TASK]);

  handle.close();
  return { prep: prep.id, email: email.id, clicked: clicked.id, browser: browser.id };
}

/** What must hold after any restart, whatever was interrupted. */
function inconsistencies(dbPath: string): string[] {
  const handle = openDb(dbPath);
  const db = handle.db;
  const queue = createQueue(db);
  const files = createFileStore(config.filesDir);
  const apps = createApplicationService({ db, files, queue, profiles: createProfileService({ db, files }) });
  const problems: string[] = [];
  const active = (type: string, id: number) => queue.recent(type, 500).some((t) => (t.status === 'pending' || t.status === 'running') && (t.payload as { applicationId?: number })?.applicationId === id);
  if (db.select().from(queueTasks).where(and(eq(queueTasks.status, 'running'), eq(queueTasks.lockedBy, 'dead-worker'))).all().length) problems.push('a task is still owned by the dead worker');
  if (db.select().from(scanRuns).where(eq(scanRuns.status, 'running')).all().length) problems.push('a scan is still "running"');
  if (db.select().from(sentEmails).where(eq(sentEmails.status, 'sending')).all().length) problems.push('an email is still "sending"');
  for (const a of db.select().from(applications).all()) {
    if (a.status === 'PREPARING' && !active(PREPARE_TASK, a.id)) problems.push(`application ${a.id} is preparing without a task`);
    if (a.status === 'APPLYING') {
      const waitingForUser = apps.sentEmails(a.id)[0]?.status === 'uncertain';
      if (!waitingForUser && !active(a.method === 'email' ? EMAIL_TASK : BROWSER_TASK, a.id)) problems.push(`application ${a.id} is applying without a task`);
    }
  }
  handle.close();
  return problems;
}

describe('crash recovery drill', () => {
  it('a fresh worker after kill -9 reaches a consistent state, resumes the work and sends nothing twice', async () => {
    const ids = await crashMidWork();
    const worker = await startWorker({ config, ...fast, env: {}, pdf, browserEngine: noBrowser });
    const check = openDb(config.dbPath);
    const db = check.db;
    const status = (id: number) => db.select().from(applications).where(eq(applications.id, id)).get()!;
    try {
      // The interrupted preparation runs again to the end.
      await waitFor(() => status(ids.prep).status === 'READY', 20_000);
      // The email that may have gone out is never sent again: the user is asked to check.
      await waitFor(() => db.select().from(sentEmails).where(and(eq(sentEmails.applicationId, ids.email), eq(sentEmails.status, 'uncertain'))).get(), 10_000);
      expect(db.select().from(sentEmails).where(eq(sentEmails.applicationId, ids.email)).all()).toHaveLength(1);
      expect(status(ids.email).status).toBe('APPLYING');
      // A website form that may have been submitted is never submitted again.
      await waitFor(() => status(ids.clicked).status === 'APPLICATION_FAILED', 10_000);
      expect(status(ids.clicked)).toMatchObject({ failureCode: 'NO_CONFIRMATION' });
      // The interrupted scan is closed as failed, and the requeued scan runs.
      await waitFor(() => db.select().from(scanRuns).all().some((r) => r.status === 'success' || r.status === 'skipped'), 10_000);
      await waitFor(() => inconsistencies(config.dbPath).length === 0 || null, 10_000).catch(() => {});
      expect(inconsistencies(config.dbPath)).toEqual([]);
      // Only the application that never reached Submit may open the browser again.
      expect(browserOpened).toBeLessThanOrEqual(1);
    } finally {
      await worker.stop();
      check.close();
    }
  }, 60_000);

  it('a second crash during recovery is recovered the same way', async () => {
    await crashMidWork();
    const first = await startWorker({ config, ...fast, env: {}, pdf, browserEngine: noBrowser });
    await first.stop();
    const again = await startWorker({ config, ...fast, env: {}, pdf, browserEngine: noBrowser });
    try {
      await waitFor(() => inconsistencies(config.dbPath).length === 0 || null, 20_000).catch(() => {});
      expect(inconsistencies(config.dbPath)).toEqual([]);
    } finally {
      await again.stop();
    }
  }, 60_000);
});
