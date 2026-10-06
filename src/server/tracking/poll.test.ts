import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import type { Ai } from '../ai';
import { fakeRoutes } from '../ai/fake';
import { createApplicationService } from '../applications/service';
import { inboxMessages, notifications, sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { createNotifier } from '../notifications/dispatcher';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import type { Envelope, MailboxSession, ParsedMessage } from './mailbox';
import { createInboxPollHandler } from './poll';
import { createTrackingService, TRACKING_SETTINGS_KEY } from './service';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-10T10:00:00Z');
});
afterEach(() => t.cleanup());

type Mail = Envelope & { text: string };
function fakeMailbox(mails: Mail[]) {
  const reads: number[] = [];
  const session: MailboxSession = {
    uidValidity: '1',
    envelopes: async (afterUid) => ({ envelopes: mails.filter((m) => !afterUid || m.uid > afterUid).map((m) => ({ uid: m.uid, messageId: m.messageId, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date, inReplyTo: m.inReplyTo, references: m.references, automated: m.automated })) }),
    read: async (uid) => {
      reads.push(uid);
      const m = mails.find((x) => x.uid === uid)!;
      return { messageId: m.messageId, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date, inReplyTo: m.inReplyTo, references: m.references, text: m.text } satisfies ParsedMessage;
    },
    close: async () => {},
  };
  return { session, reads };
}
const fakeAi = (out: unknown, onCall?: () => void): Ai => ({ ...fakeRoutes(['inbox-classify']), generateObject: async () => (onCall?.(), out as never) });
const mail = (uid: number, over: Partial<Mail>): Mail => ({ uid, messageId: `<m${uid}@x>`, from: 'someone@gmail.com', fromName: '', subject: '', date: clock, inReplyTo: null, references: [], text: '', ...over });

async function setup(mails: Mail[], trackingSettings: Record<string, unknown> = {}, opts: { ai?: Ai | null; box?: ReturnType<typeof fakeMailbox> } = {}) {
  const now = () => clock;
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files, now });
  const queue = createQueue(t.db, { now });
  const settings = createSettings(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log, now });
  const apps = createApplicationService({ db: t.db, files, queue, profiles, now });
  const notifier = createNotifier({ db: t.db, settings, queue, now });
  const tracking = createTrackingService({ db: t.db, apps, settings, now });
  settings.set(TRACKING_SETTINGS_KEY, { inboxEnabled: true, autoUpdate: false, threshold: 0.85, ...trackingSettings });
  const p = profiles.create('E');
  const d = emptyProfile();
  d.headline = 'Backend Engineer';
  d.skills = [{ id: '', name: 'Go', category: 'technology' }];
  profiles.updateData(p.id, assignIds(d), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'Pasted', config: {}, origin: 'user', createdAt: clock }).returning().get().id;
  const [jobId] = createIngestor({ db: t.db, now }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://jobs.acme.example/1', title: 'Backend Engineer', company: 'Acme Payments', description: 'Requirements\n• Go\nApply: careers@acme.example' }], { completeSnapshot: false }).changedJobIds;
  const app = matching.approve((await matching.evaluate(jobId, p.id)).matchId);
  queue.complete(queue.claim('w')!.id);
  apps.transition(app.id, 'READY', { origin: 'system', message: 'ready' });
  apps.markApplied(app.id);
  const box = opts.box ?? fakeMailbox(mails);
  const handler = createInboxPollHandler({ tracking, apps, ai: opts.ai ?? null, notifier, settings, env: { SMTP_HOST: 'smtp.gmail.com', SMTP_USERNAME: 'me@gmail.com', SMTP_PASSWORD: 'x' }, log, now, openMailbox: async () => box.session });
  const run = (signal = new AbortController().signal) => handler({}, { taskId: 1, attempt: 1, log, signal });
  return { apps, app, tracking, run, box, settings };
}

describe('inbox.poll', () => {
  it('records a matched email as seen, its interpretation as AI, and suggests the status (auto-update off)', async () => {
    const { apps, app, run, tracking } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation – Backend Engineer', text: 'We would like to invite you to a video interview. Please share your availability.' })]);
    await run();
    const events = apps.timeline(app.id);
    expect(events.find((e) => e.type === 'email_received')).toMatchObject({ origin: 'observed', message: expect.stringMatching(/talent@acme\.example.*Interview invitation/) });
    expect(events.find((e) => e.type === 'email_interpreted')).toMatchObject({ origin: 'ai', message: expect.stringMatching(/interview/i) });
    expect(apps.get(app.id)?.status).toBe('APPLIED');
    const [m] = tracking.messagesFor(app.id);
    expect(m).toMatchObject({ label: 'interview', suggestedStatus: 'INTERVIEW', resolution: null, matchedBy: 'domain' });
    tracking.applySuggestion(m.id);
    expect(apps.get(app.id)?.status).toBe('INTERVIEW');
    expect(t.db.select().from(notifications).all().some((n) => n.event === 'application.applied' || /interview/i.test(n.title))).toBe(true);
  });

  it('with auto-update on, applies a confident AI interview interpretation from the employer', async () => {
    const { apps, app, run } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to a video interview.' })], { autoUpdate: true, threshold: 0.7 }, { ai: fakeAi({ label: 'interview', confidence: 0.95, summary: 'Interview invitation' }) });
    await run();
    expect(apps.get(app.id)?.status).toBe('INTERVIEW');
    expect(apps.timeline(app.id).at(-1)).toMatchObject({ origin: 'ai', message: expect.stringMatching(/from an email/i) });
  });

  it('never auto-applies a rejection to an offer, or anything below the threshold', async () => {
    const { apps, app, run } = await setup([mail(2, { from: 'talent@acme.example', subject: 'Update', text: 'Unfortunately we have decided to move forward with other candidates.' })], { autoUpdate: true, threshold: 0.7 });
    apps.transition(app.id, 'OFFER', { origin: 'user', message: 'Offer received' });
    await run();
    expect(apps.get(app.id)?.status).toBe('OFFER');
  });

  it('reads only messages that could belong to an application, and never the same one twice', async () => {
    const { run, box, tracking, app } = await setup([
      mail(1, { from: 'deals@shop.test', subject: 'Big sale this weekend', text: 'Buy now' }),
      mail(2, { from: 'news@digest.test', subject: 'Acme Payments raises $50M', text: 'Funding news' }),
      mail(3, { from: 'talent@acme.example', subject: 'Thank you for applying', text: 'We received your application.' }),
    ]);
    await run();
    await run();
    expect(box.reads).toEqual([2, 3]); // the sale mail is never opened; the news mail is checked but not kept
    expect(tracking.messagesFor(app.id)).toHaveLength(1);
    expect(t.db.select().from(inboxMessages).all()).toHaveLength(1);
  });

  it('does nothing when tracking is off', async () => {
    const off = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview' })], { inboxEnabled: false });
    await off.run();
    expect(off.box.reads).toEqual([]);
  });
});

describe('inbox.poll safety (M8 review)', () => {
  it('automatic updates never apply an offer, even from a confident model', async () => {
    const offer = await setup([mail(1, { from: 'talent@acme.example', subject: 'Offer of employment', text: 'We are delighted to extend an offer.' })], { autoUpdate: true, threshold: 0.5 }, { ai: fakeAi({ label: 'offer', confidence: 0.99, summary: 'Offer' }) });
    await offer.run();
    expect(offer.apps.get(offer.app.id)?.status).toBe('APPLIED');
    expect(offer.tracking.messagesFor(offer.app.id)[0]).toMatchObject({ suggestedStatus: 'OFFER', resolution: null });
  });

  it('automatic updates never apply a rejection (REJECTED is final), e.g. a reschedule starting with "Unfortunately"', async () => {
    const rejection = await setup([mail(1, { from: 'talent@acme.example', subject: 'Your application', text: 'Unfortunately our interviewer is sick. Could we move our chat?' })], { autoUpdate: true, threshold: 0.5 }, { ai: fakeAi({ label: 'rejection', confidence: 0.99, summary: 'Rejected' }) });
    await rejection.run();
    expect(rejection.apps.get(rejection.app.id)?.status).toBe('APPLIED');
  });

  it('automatic updates never apply a guess by the offline rules', async () => {
    const rules = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to an interview.' })], { autoUpdate: true, threshold: 0.5 });
    await rules.run();
    expect(rules.apps.get(rules.app.id)?.status).toBe('APPLIED');
    expect(rules.tracking.messagesFor(rules.app.id)[0]).toMatchObject({ suggestedStatus: 'INTERVIEW', resolution: null });
  });

  it('automatic updates never apply mail linked only by company and title (any sender can write those)', async () => {
    const agency = await setup([mail(1, { from: 'pitch@agency.example', subject: 'Backend Engineer at Acme Payments', text: 'Interview slots for the Backend Engineer role at Acme Payments' })], { autoUpdate: true, threshold: 0.5 }, { ai: fakeAi({ label: 'interview', confidence: 0.99, summary: 'Interview' }) });
    await agency.run();
    expect(agency.tracking.messagesFor(agency.app.id)[0]).toMatchObject({ matchedBy: 'company+title', resolution: null });
    expect(agency.apps.get(agency.app.id)?.status).toBe('APPLIED');
  });

  it("never records the user's own mail (Job Scraper's notification emails echo the recruiter's subject)", async () => {
    const { run, box, tracking, app } = await setup([
      mail(1, { from: 'me@gmail.com', subject: 'Job Scraper: Acme Payments: likely interview', text: '“Interview for Backend Engineer at Acme Payments” from talent@acme.example.' }),
      mail(2, { from: 'alerts@other.example', subject: 'Acme Payments: Backend Engineer interview', text: 'Interview for Backend Engineer at Acme Payments', automated: true }),
    ]);
    await run();
    expect(box.reads).toEqual([]);
    expect(tracking.messagesFor(app.id)).toHaveLength(0);
  });

  it('the same email (same Message-ID) is recorded once, even after the mailbox was renumbered', async () => {
    const first = mail(1, { from: 'talent@acme.example', subject: 'Thank you for applying', text: 'We received your application.', messageId: '<same@acme.example>' });
    const { run, tracking, app, box } = await setup([first]);
    await run();
    box.session.uidValidity = '2';
    first.uid = 7; // the server renumbered the mailbox (or the account was reconnected another way)
    await run();
    expect(box.reads).toEqual([1]); // known by its Message-ID: not even opened again
    expect(tracking.status()).toMatchObject({ ok: true });
    expect(tracking.messagesFor(app.id)).toHaveLength(1);
  });

  it('a message that fails to load does not stop the others; it is retried, then skipped', async () => {
    const box = fakeMailbox([
      mail(1, { from: 'talent@acme.example', subject: 'Thank you for applying', text: 'We received your application.' }),
      mail(2, { from: 'talent@acme.example', subject: 'Your application', text: 'broken' }),
      mail(3, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to an interview.' }),
    ]);
    const read = box.session.read;
    box.session.read = async (uid) => (uid === 2 ? Promise.reject(new Error('FETCH failed')) : read(uid));
    const { run, tracking, app } = await setup([], {}, { box });
    await run();
    expect(tracking.messagesFor(app.id)).toHaveLength(2);
    expect(tracking.mailboxState('imap.gmail.com/me@gmail.com/INBOX')).toMatchObject({ lastUid: 1 });
    await run();
    await run();
    expect(tracking.mailboxState('imap.gmail.com/me@gmail.com/INBOX')).toMatchObject({ lastUid: 3 });
    expect(box.reads.filter((u) => u === 2)).toHaveLength(0); // the wrapped reads of 2 never reached the mailbox
    expect(tracking.status()).toMatchObject({ ok: false, message: expect.stringMatching(/skipped 1 message/i) });
  });

  it('a run stopped in the middle keeps what it finished', async () => {
    const ac = new AbortController();
    let calls = 0;
    const ai = fakeAi({ label: 'acknowledgement', confidence: 0.9, summary: 'Received' }, () => {
      if (++calls === 2) {
        ac.abort(new Error('Task timed out'));
        throw new Error('aborted');
      }
    });
    const { run, tracking } = await setup([
      mail(1, { from: 'talent@acme.example', subject: 'Thank you for applying', text: 'We received your application.' }),
      mail(2, { from: 'talent@acme.example', subject: 'Your application', text: 'More about your application.' }),
    ], {}, { ai });
    await run(ac.signal).catch(() => {});
    expect(tracking.mailboxState('imap.gmail.com/me@gmail.com/INBOX')).toMatchObject({ lastUid: 1 });
  });

  it('replies notify under their own event, not "Application submitted"', async () => {
    const { run } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to an interview.' })]);
    await run();
    const sent = t.db.select().from(notifications).all();
    expect(sent.map((n) => n.event)).toEqual(['application.reply']);
  });

  it('a suggestion made before the status changed no longer applies (M8 review minor 3)', async () => {
    const { apps, app, run, tracking } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to an interview.' })]);
    await run();
    const [m] = tracking.messagesFor(app.id);
    expect(tracking.suggestionCurrent(m)).toBe(true);
    clock = new Date(clock.getTime() + 60_000);
    apps.setStatus(app.id, 'OFFER', 'Skipped straight to an offer');
    expect(tracking.suggestionCurrent(m)).toBe(false);
    tracking.applySuggestion(m.id);
    expect(apps.get(app.id)?.status).toBe('OFFER');
    expect(tracking.messagesFor(app.id)[0].resolution).toBe('obsolete');
  });

  it('below the confidence threshold an interview stays a suggestion', async () => {
    const { apps, app, run, tracking } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Interview invitation', text: 'We would like to invite you to an interview.' })], { autoUpdate: true, threshold: 0.9 }, { ai: fakeAi({ label: 'interview', confidence: 0.85, summary: 'Interview' }) });
    await run();
    expect(apps.get(app.id)?.status).toBe('APPLIED');
    expect(tracking.messagesFor(app.id)[0]).toMatchObject({ suggestedStatus: 'INTERVIEW', resolution: null, method: 'ai' });
  });

  it('deleting an application deletes the emails stored for it', async () => {
    const { apps, app, run } = await setup([mail(1, { from: 'talent@acme.example', subject: 'Thank you for applying', text: 'We received your application.' })]);
    await run();
    expect(t.db.select().from(inboxMessages).all()).toHaveLength(1);
    await apps.remove(app.id);
    expect(t.db.select().from(inboxMessages).all()).toHaveLength(0);
  });
});
