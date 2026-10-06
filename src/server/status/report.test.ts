import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { aiUsage, applications, notifications, profiles, queueTasks, sentEmails, sourceRuns, sources } from '../db/schema';
import { systemReport } from './report';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const now = new Date(2026, 9, 10, 15, 0);
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

function seed() {
  const db = t.db;
  const greenhouse = db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme (Greenhouse)', config: {}, origin: 'user', createdAt: hoursAgo(500), lastRunAt: hoursAgo(1), lastStatus: 'failed', lastError: 'HTTP 503', consecutiveFailures: 3 }).returning().get().id;
  const remotive = db.insert(sources).values({ adapterId: 'remotive', name: 'Remotive', config: {}, origin: 'default', createdAt: hoursAgo(500), lastRunAt: hoursAgo(2), lastStatus: 'success' }).returning().get().id;
  db.insert(sourceRuns).values([
    { sourceId: remotive, status: 'success', startedAt: hoursAgo(2), finishedAt: hoursAgo(2), found: 40, newJobs: 5, updated: 2, expired: 1, parseErrors: 1 },
    { sourceId: remotive, status: 'success', startedAt: hoursAgo(30), finishedAt: hoursAgo(30), found: 38, newJobs: 3 },
    { sourceId: greenhouse, status: 'failed', startedAt: hoursAgo(1), finishedAt: hoursAgo(1), errorCode: 'SOURCE_UNAVAILABLE', error: 'HTTP 503' },
    // Older than the report window: not counted.
    { sourceId: remotive, status: 'success', startedAt: hoursAgo(24 * 9), finishedAt: hoursAgo(24 * 9), found: 999, newJobs: 999 },
  ]).run();
  const p = db.insert(profiles).values({ name: 'P', data: {}, preferences: {}, createdAt: now, updatedAt: now }).returning().get().id;
  const app = (status: (typeof applications.$inferInsert)['status'], method: 'email' | 'browser' | 'manual', failureCode: string | null, created = hoursAgo(3)) =>
    db.insert(applications).values({ profileId: p, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://y.example', status, method, failureCode, approvedAt: created, createdAt: created, updatedAt: created }).returning().get().id;
  app('APPLIED', 'email', null);
  app('APPLICATION_SKIPPED', 'browser', 'CAPTCHA_DETECTED');
  app('APPLICATION_SKIPPED', 'browser', 'CAPTCHA_DETECTED');
  app('APPLICATION_FAILED', 'browser', 'NO_CONFIRMATION');
  const emailApp = app('APPLICATION_FAILED', 'email', 'EMAIL_FAILED');
  app('PREPARATION_FAILED', 'manual', 'CV_GENERATION_FAILED', hoursAgo(24 * 20));
  db.insert(sentEmails).values([
    { applicationId: emailApp, messageId: '<a@x>', status: 'failed', provider: 'smtp', fromAddress: 'a@x', toAddress: 'b@y', subject: 's', body: 'b', attachments: [], error: '550 mailbox unavailable', createdAt: hoursAgo(3) },
    { applicationId: emailApp, messageId: '<b@x>', status: 'sent', provider: 'smtp', fromAddress: 'a@x', toAddress: 'b@y', subject: 's', body: 'b', attachments: [], createdAt: hoursAgo(4) },
  ]).run();
  db.insert(notifications).values([
    { event: 'job.matched', entityKey: 'm1', channel: 'telegram', title: 't', body: 'b', status: 'sent', createdAt: hoursAgo(5), sentAt: hoursAgo(5) },
    { event: 'job.matched', entityKey: 'm2', channel: 'telegram', title: 't', body: 'b', status: 'failed', error: '401 Unauthorized', createdAt: hoursAgo(4) },
    { event: 'job.matched', entityKey: 'm2', channel: 'inapp', title: 't', body: 'b', status: 'sent', createdAt: hoursAgo(4) },
  ]).run();
  db.insert(queueTasks).values([
    { type: 'discovery.scan', payload: {}, status: 'pending', runAt: now, createdAt: now, updatedAt: now },
    { type: 'application.prepare', payload: { applicationId: 1 }, status: 'failed', attempts: 3, runAt: hoursAgo(2), lastError: 'Render timed out', createdAt: hoursAgo(2), updatedAt: hoursAgo(2) },
  ]).run();
  db.insert(aiUsage).values([
    { task: 'tailor-cv', role: 'quality', provider: 'openai', model: 'm', inputTokens: 1000, outputTokens: 500, costUsd: 0.02, ok: true, createdAt: hoursAgo(1) },
    { task: 'tailor-cv', role: 'quality', provider: 'openai', model: 'm', inputTokens: 1000, outputTokens: 500, costUsd: 0.03, ok: true, createdAt: hoursAgo(2) },
    { task: 'match-score', role: 'fast', provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 50, costUsd: 0.001, ok: false, createdAt: hoursAgo(3) },
    { task: 'tailor-cv', role: 'quality', provider: 'openai', model: 'm', inputTokens: 1000, outputTokens: 500, costUsd: 0.5, ok: true, createdAt: hoursAgo(24 * 2) },
  ]).run();
}

describe('systemReport (PRD §52)', () => {
  it('is empty and calm on a fresh install', () => {
    const r = systemReport(t.db, { now });
    expect(r.sources).toEqual([]);
    expect(r.discovery).toEqual({ runs: 0, failedRuns: 0, found: 0, newJobs: 0, updated: 0, expired: 0, parseErrors: 0 });
    expect(r.applications.failures).toEqual([]);
    expect(r.ai).toEqual({ todayUsd: 0, weekUsd: 0, failedCalls: 0, byTask: [] });
  });

  it('shows each source with its last run and failures, and what discovery found this week', () => {
    seed();
    const r = systemReport(t.db, { now });
    expect(r.sources.map((s) => s.name)).toEqual(['Acme (Greenhouse)', 'Remotive']); // failing first
    expect(r.sources[0]).toMatchObject({ lastStatus: 'failed', lastError: 'HTTP 503', consecutiveFailures: 3, week: { runs: 1, failed: 1, found: 0, newJobs: 0 } });
    expect(r.sources[1]).toMatchObject({ week: { runs: 2, failed: 0, found: 78, newJobs: 8 } });
    expect(r.discovery).toEqual({ runs: 3, failedRuns: 1, found: 78, newJobs: 8, updated: 2, expired: 1, parseErrors: 1 });
  });

  it('counts applications made and failures by code and method, this week', () => {
    seed();
    const r = systemReport(t.db, { now });
    expect(r.applications.created).toBe(5);
    expect(r.applications.failures).toEqual([
      { code: 'CAPTCHA_DETECTED', method: 'browser', count: 2 },
      { code: 'EMAIL_FAILED', method: 'email', count: 1 },
      { code: 'NO_CONFIRMATION', method: 'browser', count: 1 },
    ]);
  });

  it('reports notification and email delivery with the latest errors', () => {
    seed();
    const r = systemReport(t.db, { now });
    expect(r.notifications).toEqual([
      { channel: 'inapp', sent: 1, failed: 0, pending: 0, lastError: null },
      { channel: 'telegram', sent: 1, failed: 1, pending: 0, lastError: '401 Unauthorized' },
    ]);
    expect(r.emails).toMatchObject({ sent: 1, failed: 1, uncertain: 0, lastError: '550 mailbox unavailable' });
  });

  it('reports the queue (with failed tasks) and AI spend today and by task', () => {
    seed();
    const r = systemReport(t.db, { now });
    expect(r.queue.counts).toMatchObject({ pending: 1, failed: 1 });
    expect(r.queue.failed).toEqual([expect.objectContaining({ type: 'application.prepare', lastError: 'Render timed out' })]);
    expect(r.ai.todayUsd).toBeCloseTo(0.051);
    expect(r.ai.weekUsd).toBeCloseTo(0.551);
    expect(r.ai.failedCalls).toBe(1);
    expect(r.ai.byTask).toEqual([
      { task: 'tailor-cv', calls: 3, failed: 0, usd: expect.closeTo(0.55) },
      { task: 'match-score', calls: 1, failed: 1, usd: expect.closeTo(0.001) },
    ]);
  });

  it('does not count a call still in flight as failed, but one left behind after the timeout', () => {
    const row = (ageMin: number) => ({ task: 'cv-extract', role: '', provider: 'openai' as const, model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0.01, ok: false, createdAt: new Date(now.getTime() - ageMin * 60_000) });
    t.db.insert(aiUsage).values([row(1), row(10)]).run();
    const r = systemReport(t.db, { now });
    expect(r.ai.failedCalls).toBe(1);
    expect(r.ai.byTask).toEqual([expect.objectContaining({ calls: 2, failed: 1 })]);
  });

  it('leaves out what is not a failure of background work: the user’s own bad links, cancelled work and the hidden “Added by you” source', () => {
    seed();
    t.db.insert(queueTasks).values([
      { type: 'discovery.url', payload: { url: 'https://www.linkedin.com/jobs/1' }, status: 'failed', attempts: 1, runAt: hoursAgo(1), lastError: 'Job Scraper does not read LinkedIn', createdAt: hoursAgo(1), updatedAt: hoursAgo(1) },
      { type: 'discovery.scan', payload: {}, status: 'failed', attempts: 0, runAt: hoursAgo(1), lastError: 'Cancelled', createdAt: hoursAgo(1), updatedAt: hoursAgo(1) },
      { type: 'notify.flush', payload: {}, status: 'failed', attempts: 3, runAt: hoursAgo(1), lastError: null, createdAt: hoursAgo(1), updatedAt: hoursAgo(3) },
    ]).run();
    t.db.insert(sources).values({ adapterId: 'manual', name: 'Added by you', config: {}, origin: 'default', enabled: false, createdAt: hoursAgo(500) }).run();
    const r = systemReport(t.db, { now });
    expect(r.queue.counts.failed).toBe(2);
    expect(r.queue.failed.map((x) => x.type)).toEqual(['application.prepare', 'notify.flush']);
    expect(r.sources.map((x) => x.name)).not.toContain('Added by you');
  });
});
