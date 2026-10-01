import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../tests/helpers/temp-db';
import { eq } from 'drizzle-orm';
import { aiUsage, applications, inboxMessages, jobAnalyses, jobListings, jobs, notifications, profiles, queueTasks, scanRuns, sourceRuns, sources } from './db/schema';
import { createIngestor } from './jobs/ingest';
import { createSettings } from './settings';
import { maintenanceDone, maintenanceDue, pruneOldData, removeOrphanFiles } from './retention';
import { createFileStore } from './storage';
import path from 'node:path';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());
const DAY = 86_400_000;
const now = new Date('2026-10-01T00:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe('pruneOldData', () => {
  it('removes old read notifications, finished tasks and scan history, keeping what is recent or unread', () => {
    const n = (createdAt: Date, readAt: Date | null) => t.db.insert(notifications).values({ event: 'x', entityKey: `k${Math.random()}`, channel: 'inapp', title: 't', body: 'b', status: 'sent', createdAt, readAt }).run();
    n(ago(100), ago(99)); // old and read → removed
    n(ago(100), null); // old but unread → kept
    n(ago(10), ago(9)); // recent → kept
    const task = (status: 'done' | 'failed' | 'pending', updatedAt: Date) => t.db.insert(queueTasks).values({ type: 'x', payload: {}, status, runAt: updatedAt, createdAt: updatedAt, updatedAt }).run();
    task('done', ago(40));
    task('done', ago(5));
    task('failed', ago(100));
    task('pending', ago(100));
    const scan = t.db.insert(scanRuns).values({ trigger: 'schedule', status: 'success', startedAt: ago(120), finishedAt: ago(120) }).returning().get();
    const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'S', config: {}, origin: 'user', createdAt: ago(200) }).returning().get();
    t.db.insert(sourceRuns).values({ scanRunId: scan.id, sourceId: src.id, status: 'success', startedAt: ago(120) }).run();
    // 22 old scans in all plus a recent one: the latest 20 always stay, so the 3 oldest go.
    for (let i = 0; i < 21; i++) t.db.insert(scanRuns).values({ trigger: 'schedule', status: 'success', startedAt: ago(110), finishedAt: ago(110) }).run();
    t.db.insert(scanRuns).values({ trigger: 'schedule', status: 'success', startedAt: ago(1), finishedAt: ago(1) }).run();

    const r = pruneOldData(t.db, now);
    expect(r).toMatchObject({ notifications: 1, tasks: 2, scans: 3 });
    expect(t.db.select().from(notifications).all()).toHaveLength(2);
    expect(t.db.select().from(queueTasks).all().map((x) => x.status).sort()).toEqual(['done', 'pending']);
    expect(t.db.select().from(scanRuns).all()).toHaveLength(20);
    expect(t.db.select().from(sourceRuns).all()).toHaveLength(0);
  });

  it('forgets email text of long-closed applications but keeps the record', () => {
    const p = t.db.insert(profiles).values({ name: 'P', isDefault: true, data: {}, preferences: {}, sliderValue: 100, createdAt: now, updatedAt: now }).returning().get();
    const app = (status: 'REJECTED' | 'INTERVIEW', updatedAt: Date) => t.db.insert(applications).values({ profileId: p.id, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://y.example', method: 'email', status, approvedAt: updatedAt, createdAt: updatedAt, updatedAt }).returning().get();
    const closed = app('REJECTED', ago(200));
    const open = app('INTERVIEW', ago(200));
    for (const [a, uid] of [[closed, 1], [open, 2]] as const) t.db.insert(inboxMessages).values({ applicationId: a.id, mailbox: 'm', uid, subject: 's', snippet: 'Dear Asha…', createdAt: ago(200) }).run();
    expect(pruneOldData(t.db, now).snippets).toBe(1);
    const rows = t.db.select().from(inboxMessages).all();
    expect(rows.find((r) => r.applicationId === closed.id)).toMatchObject({ snippet: null, subject: 's' });
    expect(rows.find((r) => r.applicationId === open.id)?.snippet).toBe('Dear Asha…');
  });

  it('frees the text of jobs gone for months (kept for duplicate detection), unused job analyses and old AI usage rows', () => {
    const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'S', config: {}, origin: 'user', createdAt: ago(300) }).returning().get();
    const listing = (id: string, description: string) => ({ sourceJobId: id, sourceUrl: `https://x.example/${id}`, title: `Role ${id}`, company: 'Acme', description });
    const old = createIngestor({ db: t.db, now: () => ago(200) });
    old.ingestRun(src.id, [listing('gone', 'A long description of a job that closed'), listing('applied', 'A job the user applied to')], { completeSnapshot: false });
    createIngestor({ db: t.db, now: () => ago(1) }).ingestRun(src.id, [listing('live', 'A job that is still open')], { completeSnapshot: false });
    t.db.update(jobs).set({ status: 'expired' }).where(eq(jobs.status, 'active')).run();
    t.db.update(jobs).set({ status: 'active' }).where(eq(jobs.title, 'Role live')).run();
    t.db.update(jobListings).set({ status: 'expired' }).where(eq(jobListings.sourceJobId, 'gone')).run();
    const p = t.db.insert(profiles).values({ name: 'P', isDefault: true, data: {}, preferences: {}, sliderValue: 100, createdAt: now, updatedAt: now }).returning().get();
    const appliedJob = t.db.select().from(jobs).where(eq(jobs.title, 'Role applied')).get()!;
    t.db.insert(applications).values({ profileId: p.id, jobId: appliedJob.id, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://y.example', method: 'email', status: 'APPLIED', approvedAt: ago(150), createdAt: ago(150), updatedAt: ago(150) }).run();
    const hashOf = (id: string) => t.db.select().from(jobListings).where(eq(jobListings.sourceJobId, id)).get()!.descriptionHash;
    for (const id of ['gone', 'live']) t.db.insert(jobAnalyses).values({ descriptionHash: hashOf(id), requirements: {}, method: 'ai', createdAt: ago(200) }).run();
    t.db.insert(aiUsage).values([ago(400), ago(10)].map((createdAt) => ({ task: 'x', role: 'fast', provider: 'openai', model: 'm', ok: true, createdAt }))).run();

    const r = pruneOldData(t.db, now);
    expect(r).toMatchObject({ descriptions: 1, analyses: 1, aiUsage: 1 });
    const description = (id: string) => t.db.select().from(jobListings).where(eq(jobListings.sourceJobId, id)).get()!.description;
    expect(description('gone')).toBe('');
    expect(description('applied')).toBe('A job the user applied to');
    expect(description('live')).toBe('A job that is still open');
    expect(t.db.select().from(jobs).all()).toHaveLength(3); // still known, so never announced as new again (N5)
    expect(t.db.select().from(jobAnalyses).all().map((a) => a.descriptionHash)).toEqual([hashOf('live')]);
    expect(t.db.select().from(aiUsage).all()).toHaveLength(1);

    // If the posting comes back, its text is stored again.
    createIngestor({ db: t.db, now: () => now }).ingestRun(src.id, [listing('gone', 'A long description of a job that closed')], { completeSnapshot: false });
    expect(description('gone')).toBe('A long description of a job that closed');
  });
});

describe('analyses still in use (round 3)', () => {
  it('keeps the analysis of any listing of an open job (its longest text may sit on a closed mirror listing)', () => {
    const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'S', config: {}, origin: 'user', createdAt: ago(300) }).returning().get();
    const ing = createIngestor({ db: t.db, now: () => ago(200) });
    ing.ingestRun(src.id, [{ sourceJobId: 'long', sourceUrl: 'https://x.example/long', title: 'Role', company: 'Acme', description: 'A long and detailed description of the role and its requirements' }], { completeSnapshot: false });
    const long = t.db.select().from(jobListings).get()!;
    t.db.update(jobListings).set({ status: 'expired' }).where(eq(jobListings.id, long.id)).run();
    t.db.insert(jobListings).values({ ...long, id: undefined, sourceJobId: 'short', sourceUrl: 'https://x.example/short', description: 'Short', descriptionHash: 'short-hash', status: 'active' }).run();
    t.db.insert(jobAnalyses).values({ descriptionHash: long.descriptionHash, requirements: {}, method: 'ai', createdAt: ago(200) }).run();
    expect(pruneOldData(t.db, now).analyses).toBe(0);
  });
});

describe('maintenanceDue', () => {
  it('is due once a week, counted across restarts (the worker rarely stays up 7 days)', () => {
    const settings = createSettings(t.db);
    expect(maintenanceDue(settings, now)).toBe(false); // first start: the clock starts
    expect(maintenanceDue(settings, new Date(now.getTime() + 2 * DAY))).toBe(false);
    expect(maintenanceDue(settings, new Date(now.getTime() + 8 * DAY))).toBe(true);
    // Until it has run, it stays due (a failed VACUUM is retried the next day, not next week).
    expect(maintenanceDue(settings, new Date(now.getTime() + 9 * DAY))).toBe(true);
    maintenanceDone(settings, new Date(now.getTime() + 9 * DAY));
    expect(maintenanceDue(settings, new Date(now.getTime() + 10 * DAY))).toBe(false);
  });
});

describe('removeOrphanFiles (round 2)', () => {
  it('removes folders of applications and profiles that no longer exist (e.g. after a crash mid-delete)', async () => {
    const files = createFileStore(path.join(t.dir, 'files'));
    const p = t.db.insert(profiles).values({ name: 'P', isDefault: true, data: {}, preferences: {}, sliderValue: 100, createdAt: now, updatedAt: now }).returning().get();
    const app = t.db.insert(applications).values({ profileId: p.id, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://y.example', method: 'email', status: 'READY', approvedAt: now, createdAt: now, updatedAt: now }).returning().get();
    for (const rel of [`applications/${app.id}/cv.pdf`, 'applications/999/cv.pdf', `profiles/${p.id}/cv.pdf`, 'profiles/998/cv.pdf']) await files.write(rel, 'x');
    expect(await removeOrphanFiles(t.db, files)).toBe(2);
    expect(await files.exists(`applications/${app.id}/cv.pdf`)).toBe(true);
    expect(await files.exists(`profiles/${p.id}/cv.pdf`)).toBe(true);
    expect(await files.exists('applications/999')).toBe(false);
    expect(await files.exists('profiles/998')).toBe(false);
  });
});
