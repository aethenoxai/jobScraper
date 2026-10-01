import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createApplyServer } from '../../../e2e/fixtures/apply-server.mjs';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { applications, notifications, sources } from '../db/schema';
import { createBrowserEngine, type BrowserEngine } from '../browser/engine';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { createNotifier } from '../notifications/dispatcher';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue, RetryLaterError } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import { BROWSER_SETTINGS_KEY, BROWSER_TASK, createBrowserApplyHandler } from './browser-apply';
import { hasRealLink, PASTED_URL } from '../discovery/add-url';
import { reconcileApplying } from './reconcile';
import { createApplicationService, type ApplicationService } from './service';

const log = createLogger({ level: 'silent' });
const server = createApplyServer();
let base = '';
let profilesDir = '';
beforeAll(async () => {
  base = await server.listen(0);
  profilesDir = mkdtempSync(path.join(tmpdir(), 'js-bp-'));
});
afterAll(async () => {
  await server.close();
  rmSync(profilesDir, { recursive: true, force: true });
});

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date(2026, 9, 1, 10, 0);
  server.submissions.length = 0;
});
afterEach(() => t.cleanup());

const noEngine: BrowserEngine = { withPage: async () => Promise.reject(new Error('the browser must not be opened')), openForSignIn: async () => {} };

async function setup(jobPaths: string | string[], engine: BrowserEngine = createBrowserEngine({ profilesDir, headless: () => true }), opts: { wrapApps?: (a: ApplicationService) => ApplicationService } = {}) {
  const paths = typeof jobPaths === 'string' ? [jobPaths] : jobPaths;
  const now = () => clock;
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files, now });
  const queue = createQueue(t.db, { now });
  const settings = createSettings(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log, now });
  const apps = createApplicationService({ db: t.db, files, queue, profiles, now });
  const notifier = createNotifier({ db: t.db, settings, queue, now });
  const p = profiles.create('Engineer');
  const d = emptyProfile();
  d.personal = { fullName: 'Asha Rao', email: 'asha@example.com', phone: '+91 98765 43210', location: 'Pune, India', country: 'India', timezone: null, links: [] };
  d.headline = 'Backend Engineer';
  d.skills = [{ id: '', name: 'Go', category: 'technology' }];
  d.application = { ...d.application, workAuthorization: 'Indian citizen' };
  profiles.updateData(p.id, assignIds(d), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'Pasted', config: {}, origin: 'user', createdAt: clock }).returning().get().id;
  const jobIds = createIngestor({ db: t.db, now }).ingestRun(src, paths.map((jobPath) => ({ sourceJobId: jobPath, sourceUrl: base + jobPath, applicationUrl: base + jobPath, title: 'Backend Engineer', company: 'Acme', location: 'Pune, India', description: 'Requirements\n• Go' })), { completeSnapshot: false }).changedJobIds;
  const all = [];
  for (const jobId of jobIds) {
    const a = matching.approve((await matching.evaluate(jobId, p.id)).matchId);
    queue.complete(queue.claim('w')!.id); // the prepare task
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    await apps.saveDocument(a.id, 'tailored_cv_pdf', 'Acme_Backend_Engineer_CV.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
    all.push(a);
  }
  const [app, ...others] = all;
  const handler = createBrowserApplyHandler({ apps: opts.wrapApps ? opts.wrapApps(apps) : apps, profiles, engine, ai: null, notifier, settings, files, log, now, allowPrivateUrls: true });
  const ctx = (attempt = 1) => ({ taskId: 1, attempt, log, signal: new AbortController().signal });
  return { apps, app, others, queue, handler, ctx, settings };
}

describe('applying in the browser (task)', () => {
  it('only after the user asks: applies, stores the screenshot and proof, and notifies', async () => {
    const { apps, app, queue, handler, ctx } = await setup('/greenhouse/acme/jobs/123');
    expect(queue.claim('w', [BROWSER_TASK])).toBeNull();
    apps.applyInBrowser(app.id);
    expect(apps.get(app.id)?.status).toBe('APPLYING');
    await handler(queue.claim('w', [BROWSER_TASK])!.payload, ctx());
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLIED', method: 'browser' });
    const steps = apps.timeline(app.id).filter((e) => e.type === 'browser_step').map((e) => e.message);
    expect(steps.join('\n')).toMatch(/Opening 127\.0\.0\.1[\s\S]*Uploaded Acme_Backend_Engineer_CV\.pdf[\s\S]*Submitting/);
    expect(apps.timeline(app.id).at(-1)).toMatchObject({ origin: 'observed', message: expect.stringMatching(/confirmed.*Thank you for applying/i) });
    expect(apps.documents(app.id).some((d) => d.kind === 'screenshot' && d.mime === 'image/png')).toBe(true);
    expect(t.db.select().from(notifications).all().some((n) => n.event === 'application.applied')).toBe(true);
    expect(server.submissions).toHaveLength(1);
  }, 60_000);

  it('a CAPTCHA skips the job with the reason and nothing is submitted', async () => {
    const { apps, app, handler, ctx } = await setup('/captcha/job');
    apps.applyInBrowser(app.id);
    await handler({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_SKIPPED', failureCode: 'CAPTCHA_DETECTED', failureReason: expect.stringMatching(/No application was submitted/) });
    expect(server.submissions).toHaveLength(0);
  }, 60_000);

  it('never submits twice: an attempt interrupted after Submit ends as NO_CONFIRMATION without opening the browser', async () => {
    const { apps, app, handler, ctx } = await setup('/greenhouse/acme/jobs/123', noEngine);
    apps.applyInBrowser(app.id);
    apps.addEvent(app.id, 'browser_submit_clicked', 'system', 'Submitted the application form', { site: '127.0.0.1' });
    await handler({ applicationId: app.id }, ctx(2));
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'NO_CONFIRMATION', failureReason: expect.stringMatching(/check your email/i) });
  });

  it('waits until tomorrow when the daily limit is reached, and paces submissions to one site', async () => {
    const { apps, app, handler, ctx, settings } = await setup('/greenhouse/acme/jobs/123', noEngine);
    settings.set(BROWSER_SETTINGS_KEY, { visible: true, dailyCap: 1 });
    // Another application was submitted in the browser earlier today.
    const other = t.db.insert(applications).values({ profileId: app.profileId, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://y.example', method: 'browser', status: 'APPLIED', approvedAt: clock, createdAt: clock, updatedAt: clock }).returning().get();
    apps.addEvent(other.id, 'browser_submit_clicked', 'system', 'Submitted', { site: 'y.example' });
    apps.applyInBrowser(app.id);
    const limited = await handler({ applicationId: app.id }, ctx()).catch((e) => e);
    expect(limited).toBeInstanceOf(RetryLaterError);
    expect((limited as RetryLaterError).delayMs).toBe(new Date(2026, 9, 2, 0, 5).getTime() - clock.getTime());

    settings.set(BROWSER_SETTINGS_KEY, { visible: true, dailyCap: 25 });
    apps.addEvent(other.id, 'browser_submit_clicked', 'system', 'Submitted', { site: '127.0.0.1' });
    const paced = await handler({ applicationId: app.id }, ctx()).catch((e) => e);
    expect(paced).toBeInstanceOf(RetryLaterError);
    expect((paced as RetryLaterError).delayMs).toBeLessThanOrEqual(60_000);
  });
});

describe('browser application outcomes and limits (M7 review)', () => {
  it.each([
    ['/otp/job', 'APPLICATION_SKIPPED', 'MFA_REQUIRED'],
    ['/login-wall/job', 'APPLICATION_SKIPPED', 'LOGIN_REQUIRED'],
    ['/unanswerable/job', 'APPLICATION_SKIPPED', 'UNSUPPORTED_APPLICATION_FLOW'],
    ['/error/job', 'APPLICATION_FAILED', 'NO_CONFIRMATION'],
  ])('%s → %s (%s), with the reason and a screenshot', async (p, status, code) => {
    const { apps, app, handler, ctx } = await setup(p);
    apps.applyInBrowser(app.id);
    await handler({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)).toMatchObject({ status, failureCode: code, failureReason: expect.stringMatching(/\w/) });
    expect(apps.documents(app.id).some((d) => d.kind === 'screenshot')).toBe(true);
  }, 60_000);

  it('a browser that keeps failing ends as BROWSER_ERROR after the last attempt', async () => {
    const broken: BrowserEngine = { withPage: async () => Promise.reject(new Error('Executable doesn’t exist')), openForSignIn: async () => {} };
    const { apps, app, handler, ctx } = await setup('/greenhouse/acme/jobs/123', broken);
    apps.applyInBrowser(app.id);
    await expect(handler({ applicationId: app.id }, ctx(1))).rejects.toThrow(/Executable/);
    expect(apps.get(app.id)?.status).toBe('APPLYING');
    await handler({ applicationId: app.id }, ctx(3));
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'BROWSER_ERROR', failureReason: expect.stringMatching(/Executable/) });
  });

  it('an applied outcome stands even if the screenshot cannot be saved', async () => {
    const { apps, app, handler, ctx } = await setup('/greenhouse/acme/jobs/123', undefined, {
      wrapApps: (a) => ({ ...a, saveDocument: async () => Promise.reject(new Error('disk full')) }),
    });
    apps.applyInBrowser(app.id);
    await handler({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)?.status).toBe('APPLIED');
  }, 60_000);

  it('two applications to one site never submit back to back: pacing is checked again inside the site lock', async () => {
    const { apps, app, others, handler, ctx } = await setup(['/greenhouse/acme/jobs/123', '/lever/acme/abc']);
    apps.applyInBrowser(app.id);
    apps.applyInBrowser(others[0].id);
    const results = await Promise.allSettled([handler({ applicationId: app.id }, ctx()), handler({ applicationId: others[0].id }, ctx())]);
    expect(server.submissions).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof RetryLaterError)).toHaveLength(1);
  }, 120_000);

  it('LinkedIn, Indeed and other never-automated sites are refused', async () => {
    const { apps, app, handler, ctx } = await setup('/greenhouse/acme/jobs/123', noEngine);
    t.db.update(applications).set({ applicationUrl: 'https://www.linkedin.com/jobs/view/1', sourceUrl: 'https://www.linkedin.com/jobs/view/1' }).where(eq(applications.id, app.id)).run();
    expect(() => apps.applyInBrowser(app.id)).toThrow(/apply on the site yourself/i);
    // A task queued before this rule existed is refused too.
    apps.transition(app.id, 'APPLYING', { origin: 'user', message: 'Applying on the job’s website' });
    await handler({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'UNSUPPORTED_APPLICATION_FLOW' });
  });

  it('an application left in APPLYING without a task: NO_CONFIRMATION after Submit, BROWSER_ERROR before', async () => {
    const { apps, app, others, queue } = await setup(['/greenhouse/acme/jobs/123', '/lever/acme/abc'], noEngine);
    apps.applyInBrowser(app.id);
    apps.applyInBrowser(others[0].id);
    // The tasks gave up (or were lost) while the applications stayed in APPLYING.
    queue.cancelPending(BROWSER_TASK);
    apps.addEvent(app.id, 'browser_submit_clicked', 'system', 'Submitted the application form', { site: '127.0.0.1' });
    expect(reconcileApplying({ apps, queue })).toMatchObject({ failed: 2 });
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'NO_CONFIRMATION' });
    expect(apps.get(others[0].id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'BROWSER_ERROR' });
  });

  it('a website application still waiting in the queue can be cancelled; a running one cannot', async () => {
    const { apps, app, queue, handler, ctx, settings } = await setup('/greenhouse/acme/jobs/123', noEngine);
    settings.set(BROWSER_SETTINGS_KEY, { visible: true, dailyCap: 1 });
    apps.addEvent(app.id, 'browser_submit_clicked', 'system', 'Submitted elsewhere', { site: 'y.example' });
    apps.applyInBrowser(app.id);
    await handler({ applicationId: app.id }, ctx()).catch(() => {});
    expect(apps.browserQueue(app.id)).toEqual({ waiting: true, reason: expect.stringMatching(/Daily limit of 1/) });
    apps.cancelBrowserApply(app.id);
    expect(apps.get(app.id)?.status).toBe('READY');
    expect(queue.claim('w', [BROWSER_TASK])).toBeNull();

    apps.applyInBrowser(app.id);
    expect(apps.browserQueue(app.id)).toEqual({ waiting: true, reason: null });
    queue.claim('w', [BROWSER_TASK]);
    expect(apps.browserQueue(app.id)).toEqual({ waiting: false, reason: null });
    expect(() => apps.cancelBrowserApply(app.id)).toThrow(/already/);
    // Nor can a manual status change pull it out from under the running browser.
    for (const to of ['READY', 'APPLIED', 'EXPIRED'] as const) expect(() => apps.setStatus(app.id, to)).toThrow(/while it is being sent/);
    expect(apps.get(app.id)?.status).toBe('APPLYING');
  });

  it('a job pasted without a link can’t be applied to in the browser (new-user review #4)', async () => {
    const { apps, app } = await setup('/greenhouse/acme/jobs/123', noEngine);
    t.db.update(applications).set({ applicationUrl: null, sourceUrl: PASTED_URL }).where(eq(applications.id, app.id)).run();
    expect(() => apps.applyInBrowser(app.id)).toThrow(/pasted without a link/);
    expect(hasRealLink(PASTED_URL)).toBe(false);
    expect(hasRealLink('https://jobs.example.test/1')).toBe(true);
  });
});
