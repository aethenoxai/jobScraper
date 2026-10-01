import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { applicationEvents, notifications, documents, matches, sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService, PREPARE_TASK } from '../matching/service';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createFileStore, StoragePaths } from '../storage';
import { offlineTailor } from '../tailoring/offline';
import { heuristicAnalysis } from '../matching/analysis';
import { ApplicationNotFoundError, createApplicationService, InvalidTransitionError, RENDER_TASK } from './service';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

const JD = 'Requirements\n• 3+ years of experience\n• Go\n• PostgreSQL';

async function setup() {
  const now = () => clock;
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files, now });
  const queue = createQueue(t.db, { now });
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log: createLogger({ level: 'silent' }), now });
  const apps = createApplicationService({ db: t.db, files, queue, profiles, now });
  const p = profiles.create('Engineer');
  const data = emptyProfile();
  data.headline = 'Backend Engineer';
  data.yearsExperience = 5;
  data.skills = ['Go', 'PostgreSQL'].map((name) => ({ id: '', name, category: 'technology' as const }));
  data.experience = [{ id: '', title: 'Backend Engineer', company: 'Example Co', location: null, startDate: '2020-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built Go services handling 2M requests a day' }] }];
  profiles.updateData(p.id, assignIds(data), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 100);
  const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme careers', config: {}, origin: 'user', createdAt: clock }).returning().get().id;
  const ing = createIngestor({ db: t.db, now });
  const approveJob = async (id: string, title = 'Backend Engineer') => {
    const [jobId] = ing.ingestRun(src, [{ sourceJobId: id, sourceUrl: `https://x.example/${id}`, title, company: `Acme ${id}`, location: 'Remote', description: JD }], { completeSnapshot: false }).changedJobIds;
    const m = await matching.evaluate(jobId, p.id);
    return matching.approve(m.matchId);
  };
  return { apps, files, profiles, queue, matching, profileId: p.id, approveJob };
}

describe('application service', () => {
  it('a document saved while the application is being deleted leaves no files behind (M5 deferred minor)', async () => {
    const { apps, files, approveJob } = await setup();
    const a = await approveJob('a');
    const write = files.write.bind(files);
    // The user deletes the application while the worker is writing its PDF.
    (files as { write: typeof files.write }).write = async (rel, data) => {
      await apps.remove(a.id);
      return write(rel, data);
    };
    await expect(apps.saveDocument(a.id, 'tailored_cv_pdf', 'CV.pdf', 'application/pdf', Buffer.from('%PDF'))).rejects.toBeInstanceOf(ApplicationNotFoundError);
    expect(existsSync(path.join(t.dir, 'files', StoragePaths.applicationDir(a.id)))).toBe(false);
  });

  it('lists applications by status with counts for each tab', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    await approveJob('b');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'Package ready' });
    expect(apps.list({ status: 'READY' }).items.map((x) => x.id)).toEqual([a.id]);
    expect(apps.list({}).items).toHaveLength(2);
    expect(apps.list({ status: ['READY', 'PREPARING'] }).items).toHaveLength(2);
    expect(apps.counts()).toMatchObject({ PREPARING: 1, READY: 1 });
  });

  it('changes status only along the state machine, recording an event for each change', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'Package ready' });
    expect(() => apps.transition(a.id, 'INTERVIEW', { origin: 'user', message: 'x' })).toThrow(InvalidTransitionError);
    expect(apps.get(a.id)?.status).toBe('READY');
    expect(apps.timeline(a.id).map((e) => e.type)).toEqual(['approved', 'status']);
  });

  it('marking as applied records when and how', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    clock = new Date(clock.getTime() + 3_600_000);
    apps.markApplied(a.id, 'Applied on the company site');
    expect(apps.get(a.id)).toMatchObject({ status: 'APPLIED', method: 'manual', submittedAt: clock });
    expect(apps.timeline(a.id).at(-1)?.message).toMatch(/company site/);
  });

  it('keeps one document per kind, replacing older versions (one tailored CV per application)', async () => {
    const { apps, files, approveJob } = await setup();
    const a = await approveJob('a');
    await apps.saveDocument(a.id, 'tailored_cv_pdf', 'Acme_Backend_Engineer_CV.pdf', 'application/pdf', Buffer.from('v1'));
    await apps.saveDocument(a.id, 'tailored_cv_pdf', 'Acme_Backend_Engineer_CV.pdf', 'application/pdf', Buffer.from('v2'));
    const docs = apps.documents(a.id);
    expect(docs).toHaveLength(1);
    expect((await files.read(docs[0].path)).toString()).toBe('v2');
    expect(docs[0].path.startsWith(StoragePaths.applicationDir(a.id))).toBe(true);
  });

  it('the database itself allows one document per kind (screenshots and attachments may repeat)', async () => {
    const { approveJob } = await setup();
    const a = await approveJob('a');
    const doc = (kind: 'tailored_cv_pdf' | 'screenshot') => t.db.insert(documents).values({ applicationId: a.id, kind, path: `applications/${a.id}/${kind}-${Math.random()}`, filename: 'f', mime: 'application/pdf', createdAt: clock }).run();
    doc('tailored_cv_pdf');
    expect(() => doc('tailored_cv_pdf')).toThrow(/UNIQUE/);
    doc('screenshot');
    doc('screenshot');
  });

  it('27 approvals give 27 applications, each with its own single tailored CV (N2)', async () => {
    const { apps, approveJob } = await setup();
    const created = [];
    for (let i = 0; i < 27; i++) created.push(await approveJob(`batch-${i}`, `Backend Engineer ${i}`));
    for (const app of created) await apps.saveDocument(app.id, 'tailored_cv_pdf', `cv-${app.id}.pdf`, 'application/pdf', Buffer.from(`pdf ${app.id}`));
    expect(new Set(created.map((a) => a.id)).size).toBe(27);
    const pdfs = t.db.select().from(documents).all().filter((d) => d.kind === 'tailored_cv_pdf');
    expect(pdfs).toHaveLength(27);
    expect(new Set(pdfs.map((d) => d.path)).size).toBe(27);
  });

  it('checks an edited CV against the profile before saving it, then queues re-rendering', async () => {
    const { apps, profiles, profileId, queue, approveJob } = await setup();
    const a = await approveJob('a');
    const profile = profiles.get(profileId)!.data;
    const cv = offlineTailor(profile, heuristicAnalysis('Backend Engineer', JD), 'standard');
    await apps.saveTailoredCv(a.id, { cv, template: 'classic', repairs: 0 });
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });

    const invented = { ...cv, skills: [...cv.skills, 'Kubernetes'] };
    const bad = await apps.saveEditedCv(a.id, invented);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.message).join(' ')).toMatch(/Kubernetes/);
    expect(apps.tailoredCv(a.id)?.cv.skills).not.toContain('Kubernetes');

    const edited = { ...cv, summary: 'Backend engineer building Go services.' };
    expect((await apps.saveEditedCv(a.id, edited)).ok).toBe(true);
    expect(apps.tailoredCv(a.id)?.cv).toMatchObject({ summary: 'Backend engineer building Go services.', method: 'edited' });
    expect(apps.renderPending(a.id)).toBe(true);
    expect(queue.claim('w', [RENDER_TASK])?.payload).toEqual({ applicationId: a.id });
    expect(apps.timeline(a.id).some((e) => e.type === 'cv_edited')).toBe(true);
  });

  it('tracks what happens after applying: status, notes, interviews, offer, upcoming interviews', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    apps.markApplied(a.id);
    apps.setStatus(a.id, 'INTERVIEW', 'Recruiter called');
    expect(() => apps.setStatus(a.id, 'PREPARING')).toThrow(InvalidTransitionError);
    apps.addNote(a.id, 'Ask about on-call rotation');
    const at = new Date(clock.getTime() + 2 * 86_400_000);
    apps.addInterview(a.id, { at, kind: 'video', details: 'Panel with two engineers' });
    apps.addInterview(a.id, { at: new Date(clock.getTime() - 86_400_000), kind: 'phone', details: 'Screen' });
    apps.setOffer(a.id, { salary: '32 LPA', deadline: new Date(clock.getTime() + 7 * 86_400_000), notes: null });
    const types = apps.timeline(a.id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['note', 'interview_scheduled', 'offer_details']));
    expect(apps.get(a.id)?.status).toBe('INTERVIEW');
    expect(apps.upcomingInterviews(5)).toEqual([expect.objectContaining({ applicationId: a.id, company: 'Acme a', kind: 'video', at })]);
    // A closed application's interviews are not "upcoming" any more (M8 review minor 10).
    apps.setStatus(a.id, 'REJECTED', 'Not selected');
    expect(apps.upcomingInterviews(5)).toEqual([]);
  });

  it('keeps the CV as it was once applied: no edits or template changes after APPLIED', async () => {
    const { apps, profiles, profileId, approveJob } = await setup();
    const a = await approveJob('a');
    const cv = offlineTailor(profiles.get(profileId)!.data, heuristicAnalysis('Backend Engineer', JD), 'standard');
    await apps.saveTailoredCv(a.id, { cv, template: 'classic', repairs: 0 });
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    expect(apps.canEdit(a.id)).toBe(true);
    apps.markApplied(a.id);
    expect(apps.canEdit(a.id)).toBe(false);
    await expect(apps.saveEditedCv(a.id, { ...cv, summary: 'Changed after applying.' })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(apps.setTemplate(a.id, 'modern')).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(apps.tailoredCv(a.id)?.template).toBe('classic');
  });

  it('deleting removes the application, its documents, events and files, never the profile or master CV', async () => {
    const { apps, files, profiles, profileId, approveJob } = await setup();
    const a = await approveJob('a');
    await files.write(`${StoragePaths.masterCvDir(profileId)}/cv.pdf`, 'master');
    await apps.saveDocument(a.id, 'tailored_cv_pdf', 'x.pdf', 'application/pdf', Buffer.from('pdf'));
    await apps.remove(a.id);
    expect(apps.get(a.id)).toBeNull();
    expect(t.db.select().from(documents).all()).toHaveLength(0);
    expect(t.db.select().from(applicationEvents).all()).toHaveLength(0);
    expect(await files.exists(StoragePaths.applicationDir(a.id))).toBe(false);
    expect(await files.exists(`${StoragePaths.masterCvDir(profileId)}/cv.pdf`)).toBe(true);
    expect(profiles.get(profileId)).not.toBeNull();
    // The job can be approved again.
    expect(t.db.select().from(matches).where(eq(matches.id, a.matchId!)).get()?.reviewState).toBe('VIEWED');
  });

  it('deleting an application also removes notifications about it (they would only lead to a missing page)', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    const b = await approveJob('b');
    const note = (id: number, channel: 'inapp' | 'telegram') => ({ event: 'application.ready', entityKey: `application:${id}:ready:1`, channel, title: 't', body: 'b', link: `/applications/${id}`, status: 'sent' as const, createdAt: clock });
    t.db.insert(notifications).values([note(a.id, 'inapp'), note(a.id, 'telegram'), note(b.id, 'inapp')]).run();
    await apps.remove(a.id);
    expect(t.db.select().from(notifications).all().map((n) => n.link)).toEqual([`/applications/${b.id}`]);
  });

  it('retries a failed preparation', async () => {
    const { apps, queue, approveJob } = await setup();
    const a = await approveJob('a');
    queue.complete(queue.claim('w', [PREPARE_TASK])!.id);
    apps.transition(a.id, 'PREPARATION_FAILED', { origin: 'system', message: 'PDF failed', failureCode: 'CV_GENERATION_FAILED', failureReason: 'Chromium missing' });
    expect(apps.get(a.id)).toMatchObject({ failureCode: 'CV_GENERATION_FAILED' });
    apps.retryPreparation(a.id);
    expect(apps.get(a.id)).toMatchObject({ status: 'PREPARING', failureCode: null, failureReason: null });
    expect(queue.claim('w', [PREPARE_TASK])?.payload).toEqual({ applicationId: a.id });
  });

  it('retrying a preparation is one change: if it cannot be queued, the application stays failed', async () => {
    const { apps, queue, approveJob } = await setup();
    const a = await approveJob('a');
    queue.complete(queue.claim('w', [PREPARE_TASK])!.id);
    apps.transition(a.id, 'PREPARATION_FAILED', { origin: 'system', message: 'PDF failed' });
    const enqueue = queue.enqueue;
    queue.enqueue = () => { throw new Error('database is locked'); };
    expect(() => apps.retryPreparation(a.id)).toThrow(/locked/);
    queue.enqueue = enqueue;
    expect(apps.get(a.id)?.status).toBe('PREPARATION_FAILED');
  });

  it('"send again" after an uncertain email is one change: if it cannot be queued, the email stays uncertain', async () => {
    const { apps, queue, approveJob } = await setup();
    const a = await approveJob('a');
    const row = apps.recordEmailAttempt({ applicationId: a.id, messageId: '<m@x>', provider: 'smtp', fromAddress: 'a@x.example', toAddress: 'jobs@x.example', subject: 's', body: 'b', attachments: [] });
    apps.updateEmail(row.id, { status: 'uncertain' });
    const enqueue = queue.enqueue;
    queue.enqueue = () => { throw new Error('database is locked'); };
    await expect(apps.resolveUncertainEmail(a.id, 'send-again')).rejects.toThrow(/locked/);
    queue.enqueue = enqueue;
    expect(apps.sentEmails(a.id)[0].status).toBe('uncertain');
  });

  it('deleting an application also removes its email text from the work queue (N10)', async () => {
    const { apps, queue, approveJob } = await setup();
    const a = await approveJob('a');
    const b = await approveJob('b');
    const draft = (id: number) => ({ applicationId: id, draft: { to: 'jobs@x.example', subject: 'Application', body: 'Dear team, my private letter' } });
    const done = queue.enqueue('application.email', draft(a.id));
    queue.complete(queue.claim('w', ['application.email'])!.id);
    queue.enqueue('application.email', draft(b.id));
    await apps.remove(a.id);
    expect(JSON.stringify(queue.get(done.id)?.payload)).not.toMatch(/private letter|jobs@x/);
    expect(JSON.stringify(queue.recent('application.email', 10).map((x) => x.payload))).toMatch(/private letter/);
  });

  it('user actions wait for the worker’s write to finish instead of failing with "database is locked" (round 2)', async () => {
    const { apps, queue, approveJob } = await setup();
    const a = await approveJob('a');
    queue.complete(queue.claim('w', [PREPARE_TASK])!.id);
    apps.transition(a.id, 'PREPARATION_FAILED', { origin: 'system', message: 'PDF failed' });
    // Another connection (like the worker's) holds the write lock for a moment.
    const holder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const db = new (require(workerData.mod))(workerData.file);
       db.exec('BEGIN IMMEDIATE');
       db.prepare("insert into settings (key, value, updated_at) values ('lock', '1', 1)").run();
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { mod: createRequire(import.meta.url).resolve('better-sqlite3'), file: t.file } },
    );
    await new Promise((resolve) => holder.once('message', resolve));
    expect(() => apps.retryPreparation(a.id)).not.toThrow();
    expect(apps.get(a.id)?.status).toBe('PREPARING');
    await holder.terminate();
  });

  it('scheduling an interview moves an application from Applied to Interview (round 2)', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    apps.markApplied(a.id, '');
    apps.addInterview(a.id, { at: new Date('2026-10-05T10:00:00Z'), kind: 'video', details: null });
    expect(apps.get(a.id)?.status).toBe('INTERVIEW');
    // Later interviews (or an offer stage) don't change it again.
    apps.setStatus(a.id, 'OFFER', '');
    apps.addInterview(a.id, { at: new Date('2026-10-06T10:00:00Z'), kind: 'onsite', details: null });
    expect(apps.get(a.id)?.status).toBe('OFFER');
  });

  it('shows batch progress for recent approvals', async () => {
    const { apps, approveJob } = await setup();
    const a = await approveJob('a');
    await approveJob('b');
    await approveJob('c');
    apps.transition(a.id, 'READY', { origin: 'system', message: 'ready' });
    expect(apps.batchProgress()).toEqual({ approved: 3, preparing: 2, ready: 1, failed: 0 });
  });
});
