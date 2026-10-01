import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { notifications, sentEmails, sources } from '../db/schema';
import type { Mailer, SendResult } from '../email/mailer';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { createNotifier } from '../notifications/dispatcher';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue, PermanentError } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import { createPrepareHandler } from './prepare';
import { createEmailSendHandler, EMAIL_TASK } from './email-send';
import { reconcileApplying } from './reconcile';
import { rmSync } from 'node:fs';
import { createApplicationService, RENDER_TASK } from './service';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

type SendImpl = (mail: Parameters<Mailer['send']>[0]) => Promise<SendResult>;
const accepted: SendImpl = async (m) => ({ messageId: m.messageId!, raw: '', provider: 'smtp', from: 'asha@example.com', accepted: [m.to], rejected: [], response: '250 2.0.0 OK queued as 123' });

async function setup() {
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files });
  const queue = createQueue(t.db);
  const settings = createSettings(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
  const apps = createApplicationService({ db: t.db, files, queue, profiles });
  const notifier = createNotifier({ db: t.db, settings, queue });
  const p = profiles.create('Engineer');
  const data = emptyProfile();
  data.personal.fullName = 'Asha Rao';
  data.personal.email = 'asha@example.com';
  data.headline = 'Backend Engineer';
  data.yearsExperience = 5;
  data.skills = ['Go', 'PostgreSQL'].map((name) => ({ id: '', name, category: 'technology' as const }));
  profiles.updateData(p.id, assignIds(data), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 100);
  const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'Pasted', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const [jobId] = createIngestor({ db: t.db }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://x.example/1', title: 'Backend Engineer', company: 'Acme', description: 'Requirements\n• Go\n• PostgreSQL\nApply: careers@acme.example' }], { completeSnapshot: false }).changedJobIds;
  const app = matching.approve((await matching.evaluate(jobId, p.id)).matchId);
  const pdf = { render: async () => Buffer.from('%PDF-1.7'), close: async () => {} };
  await createPrepareHandler({ apps, profiles, matching, ai: null, pdf, notifier, log })({ applicationId: app.id }, { taskId: 1, attempt: 1, log, signal: new AbortController().signal });
  const sent: Array<Parameters<Mailer['send']>[0]> = [];
  let impl: SendImpl = accepted;
  const mailer = { status: () => ({ ok: true, reason: null, from: 'asha@example.com', provider: 'smtp' as const }), send: async (m: Parameters<Mailer['send']>[0]) => (sent.push(m), impl(m)) } as unknown as Mailer;
  const handler = createEmailSendHandler({ apps, mailer, notifier, log });
  const ctx = (attempt = 1) => ({ taskId: 1, attempt, log, signal: new AbortController().signal });
  const setImpl = (f: SendImpl) => (impl = f);
  return { apps, app, queue, handler, ctx, sent, setImpl };
}

describe('sending an application email', () => {
  it('sends only after the user asks, with the CV attached, and marks the application applied with evidence', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    expect(apps.get(app.id)?.status).toBe('READY');
    expect(queue.claim('w', [EMAIL_TASK])).toBeNull();

    const draft = { ...apps.emailDraft(app.id)!, subject: 'Application: Backend Engineer (Asha Rao)' };
    await apps.sendEmail(app.id, draft);
    expect(apps.get(app.id)?.status).toBe('APPLYING');
    const task = queue.claim('w', [EMAIL_TASK])!;
    await handler(task.payload, ctx());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'careers@acme.example', subject: 'Application: Backend Engineer (Asha Rao)' });
    expect(sent[0].attachments?.map((a) => a.filename)).toEqual(['Acme_Backend_Engineer_CV.pdf']);
    expect(sent[0].messageId).toMatch(/^<[\w-]+@example\.com>$/);
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLIED', method: 'email' });
    const last = apps.timeline(app.id).at(-1)!;
    expect(last).toMatchObject({ origin: 'observed' });
    expect(last.message).toMatch(/careers@acme\.example.*250 2\.0\.0 OK/);
    expect(apps.sentEmails(app.id)).toMatchObject([{ status: 'sent', messageId: sent[0].messageId, response: '250 2.0.0 OK queued as 123' }]);
    expect(t.db.select().from(notifications).all().some((n) => n.event === 'application.applied')).toBe(true);
  });

  it('sends exactly the draft the user confirmed, even if another tab saves a different one meanwhile (M6 deferred minor)', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    const confirmed = { ...apps.emailDraft(app.id)!, subject: 'Confirmed subject' };
    await apps.sendEmail(app.id, confirmed);
    await apps.saveEmailDraft(app.id, { ...confirmed, subject: 'Stale subject from another tab', to: 'someone-else@acme.example' });
    await handler(queue.claim('w', [EMAIL_TASK])!.payload, ctx());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'careers@acme.example', subject: 'Confirmed subject' });
  });

  it('attaches the cover letter PDF when asked', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    await apps.sendEmail(app.id, { ...apps.emailDraft(app.id)!, attachCoverLetter: true });
    await handler(queue.claim('w', [EMAIL_TASK])!.payload, ctx());
    expect(sent[0].attachments?.map((a) => a.filename)).toEqual(['Acme_Backend_Engineer_CV.pdf', 'Acme_Backend_Engineer_Cover_Letter.pdf']);
  });

  it('never sends twice: a crash mid-send leaves the email "uncertain" for the user to resolve', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    const task = queue.claim('w', [EMAIL_TASK])!;
    // Simulate a crash after the row was written and the provider was called, before the result was stored.
    t.db.insert(sentEmails).values({ applicationId: app.id, messageId: '<crashed@example.com>', status: 'sending', provider: 'smtp', fromAddress: 'asha@example.com', toAddress: 'careers@acme.example', subject: 's', body: 'b', attachments: [], createdAt: new Date() }).run();
    await handler(task.payload, ctx(2));
    expect(sent).toHaveLength(0);
    expect(apps.sentEmails(app.id)[0]).toMatchObject({ status: 'uncertain' });
    expect(apps.get(app.id)?.status).toBe('APPLYING');

    await apps.resolveUncertainEmail(app.id, 'was-sent');
    expect(apps.get(app.id)?.status).toBe('APPLIED');
    expect(apps.timeline(app.id).at(-1)).toMatchObject({ origin: 'user' });
  });

  it('"send again" after an uncertain attempt sends a fresh email', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    queue.complete(queue.claim('w', [EMAIL_TASK])!.id);
    t.db.insert(sentEmails).values({ applicationId: app.id, messageId: '<lost@example.com>', status: 'uncertain', provider: 'smtp', fromAddress: 'a', toAddress: 'b', subject: 's', body: 'b', attachments: [], createdAt: new Date() }).run();
    await apps.resolveUncertainEmail(app.id, 'send-again');
    await handler(queue.claim('w', [EMAIL_TASK])!.payload, ctx());
    expect(sent).toHaveLength(1);
    expect(apps.get(app.id)?.status).toBe('APPLIED');
    expect(apps.sentEmails(app.id).map((e) => e.status).sort()).toEqual(['failed', 'sent']);
  });

  it('a refused sign-in or recipient fails the application with the reason (EMAIL_FAILED)', async () => {
    const { apps, app, queue, handler, ctx, setImpl } = await setup();
    setImpl(async () => Promise.reject(new PermanentError('The mail server rejected the message: 550 5.1.1 No such user')));
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    await handler(queue.claim('w', [EMAIL_TASK])!.payload, ctx());
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'EMAIL_FAILED', failureReason: expect.stringMatching(/No such user/) });
    expect(apps.sentEmails(app.id)[0]).toMatchObject({ status: 'failed' });
  });

  it('retries when the server could not be reached, and never when the message may have gone out', async () => {
    const { apps, app, queue, handler, ctx, setImpl, sent } = await setup();
    setImpl(async () => Promise.reject(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' })));
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    const task = queue.claim('w', [EMAIL_TASK])!;
    await expect(handler(task.payload, ctx(1))).rejects.toThrow(/timeout/);
    expect(apps.sentEmails(app.id)[0].status).toBe('failed');
    expect(apps.get(app.id)?.status).toBe('APPLYING');

    // What nodemailer produces when the connection closes after the message went out.
    setImpl(async () => Promise.reject(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' })));
    await handler(task.payload, ctx(2));
    expect(apps.sentEmails(app.id)[0].status).toBe('uncertain');
    await handler(task.payload, ctx(3));
    expect(sent).toHaveLength(2);
  });

  it('refuses drafts that would send to several people or are not ready', async () => {
    const { apps, app } = await setup();
    await expect(apps.sendEmail(app.id, { to: 'a@x.example, b@x.example', subject: 's', body: 'b', attachCoverLetter: false })).rejects.toThrow();
    apps.withdraw(app.id);
    await expect(apps.sendEmail(app.id, apps.emailDraft(app.id)!)).rejects.toThrow(/Withdrawn/);
  });

  it('an edited cover letter is checked against the profile, refreshes the email body and re-renders', async () => {
    const { apps, app, queue } = await setup();
    const job = { title: 'Backend Engineer', company: 'Acme', description: '' };
    const current = apps.coverLetter(app.id)!.letter;
    const bad = await apps.saveEditedCoverLetter(app.id, { ...current, paragraphs: ['At Google I ran Kubernetes for 9 years.'] }, job);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.message).join(' ')).toMatch(/Google/);
    const good = await apps.saveEditedCoverLetter(app.id, { ...current, paragraphs: ['I am applying for the Backend Engineer role at Acme, working with Go every day.'] }, job);
    expect(good.ok).toBe(true);
    expect(apps.coverLetter(app.id)?.letter.method).toBe('edited');
    expect(apps.emailDraft(app.id)?.body).toContain('working with Go every day');
    expect(queue.claim('w', [RENDER_TASK])?.payload).toEqual({ applicationId: app.id });
  });

  it('a problem before anything was sent (CV file gone) fails the application on the last attempt instead of leaving it stuck', async () => {
    const { apps, app, queue, handler, ctx, sent } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    const task = queue.claim('w', [EMAIL_TASK])!;
    rmSync(apps.documents(app.id).find((d) => d.kind === 'tailored_cv_pdf')!.path.replace(/^/, `${t.dir}/files/`));
    await expect(handler(task.payload, ctx(1))).rejects.toThrow();
    await handler(task.payload, ctx(3));
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'EMAIL_FAILED' });
    expect(sent).toHaveLength(0);
  });

  it('a send that outlives its task timeout is marked uncertain at once, and a late failure does not undo that', async () => {
    const { apps, app, queue, handler, setImpl } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    const ac = new AbortController();
    setImpl(async () => {
      ac.abort(new Error('Task timed out after 120000 ms'));
      await new Promise((r) => setTimeout(r, 20));
      throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' });
    });
    await handler(queue.claim('w', [EMAIL_TASK])!.payload, { taskId: 1, attempt: 1, log, signal: ac.signal }).catch(() => {});
    expect(apps.sentEmails(app.id)[0].status).toBe('uncertain');
  });

  it('reconciliation never leaves an application applying without a task', async () => {
    const { apps, app, queue } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    // The worker died mid-send on its last attempt: the task gave up, the attempt row still says "sending".
    const task = queue.claim('w', [EMAIL_TASK])!;
    apps.recordEmailAttempt({ applicationId: app.id, messageId: '<x@example.com>', provider: 'smtp', fromAddress: 'a@example.com', toAddress: 'careers@acme.example', subject: 's', body: 'b', attachments: [] });
    queue.fail(task.id, new PermanentError('worker crashed'));
    expect(reconcileApplying({ apps, queue })).toEqual({ uncertain: 1, failed: 0 });
    expect(apps.sentEmails(app.id)[0].status).toBe('uncertain');
    expect(apps.get(app.id)?.status).toBe('APPLYING'); // waiting for the user's answer, with the buttons shown
  });

  it('reconciliation fails an application whose send task gave up before any attempt', async () => {
    const { apps, app, queue } = await setup();
    await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
    const task = queue.claim('w', [EMAIL_TASK])!;
    queue.fail(task.id, new PermanentError('The CV could not be read'));
    expect(reconcileApplying({ apps, queue })).toEqual({ uncertain: 0, failed: 1 });
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureReason: expect.stringMatching(/CV could not be read/) });
  });

  it('refuses to send while the PDF is being updated after an edit (it would mail the old one)', async () => {
    const { apps, app } = await setup();
    const saved = apps.tailoredCv(app.id)!;
    expect((await apps.saveEditedCv(app.id, { ...saved.cv, summary: 'Edited just now.' })).ok).toBe(true);
    await expect(apps.sendEmail(app.id, apps.emailDraft(app.id)!)).rejects.toThrow(/PDF is being updated/);
    expect(() => apps.applyInBrowser(app.id)).toThrow(/PDF is being updated/);
  });
});
