/**
 * Sending against a real SMTP server: which failures may be retried (certainly not sent) and which must never be
 * (the message may already be with the recruiter). Error shapes are nodemailer's own, not hand-made.
 */
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { sources } from '../db/schema';
import { createMailer } from '../email/mailer';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { createNotifier } from '../notifications/dispatcher';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import { createEmailSendHandler } from './email-send';
import { createApplicationService } from './service';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
let smtp: SMTPServer | null = null;
beforeEach(() => (t = createTempDb()));
afterEach(async () => {
  await new Promise<void>((r) => (smtp ? smtp.close(() => r()) : r()));
  smtp = null;
  t.cleanup();
});

/** An SMTP server on a free port with the given behaviour; resolves to its port. */
function startSmtp(over: Partial<SMTPServerOptions>): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  smtp = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth: (_a, _s, cb) => cb(null, { user: 'me' }),
    onData(stream, _s, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        received.push(raw);
        cb();
      });
    },
    logger: false,
    ...over,
  } as SMTPServerOptions);
  return new Promise((resolve) => smtp!.listen(0, '127.0.0.1', () => resolve({ port: (smtp!.server.address() as { port: number }).port, received })));
}

const freePort = () => new Promise<number>((resolve) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

async function setup(port: number, socketTimeoutMs = 30_000) {
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files });
  const queue = createQueue(t.db);
  const settings = createSettings(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
  const apps = createApplicationService({ db: t.db, files, queue, profiles });
  const notifier = createNotifier({ db: t.db, settings, queue });
  const p = profiles.create('E');
  const d = emptyProfile();
  d.personal.fullName = 'Asha Rao';
  d.headline = 'Backend Engineer';
  d.skills = [{ id: '', name: 'Go', category: 'technology' }];
  profiles.updateData(p.id, assignIds(d), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'Pasted', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const [jobId] = createIngestor({ db: t.db }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://x.example/1', title: 'Backend Engineer', company: 'Acme', description: 'Requirements\n• Go\nApply: careers@acme.example' }], { completeSnapshot: false }).changedJobIds;
  const app = matching.approve((await matching.evaluate(jobId, p.id)).matchId);
  queue.complete(queue.claim('w')!.id);
  apps.transition(app.id, 'READY', { origin: 'system', message: 'ready' });
  await apps.saveDocument(app.id, 'tailored_cv_pdf', 'Acme_CV.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
  await apps.saveEmailDraft(app.id, { to: 'careers@acme.example', subject: 'Application', body: 'Hello', attachCoverLetter: false });
  await apps.sendEmail(app.id, apps.emailDraft(app.id)!);
  const mailer = createMailer({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'secret-pass-9', SMTP_ALLOW_SELF_SIGNED: 'true' }, timeouts: { connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: socketTimeoutMs } });
  const handler = createEmailSendHandler({ apps, mailer, notifier, log });
  const run = (attempt = 1) => handler({ applicationId: app.id }, { taskId: 1, attempt, log, signal: new AbortController().signal });
  return { apps, app, run };
}

describe('send failures against a real SMTP server', () => {
  it('connection refused: certainly not sent, so it is retried', async () => {
    const { apps, app, run } = await setup(await freePort());
    await expect(run()).rejects.toThrow();
    expect(apps.sentEmails(app.id)[0].status).toBe('failed');
    expect(apps.get(app.id)?.status).toBe('APPLYING');
  });

  it('sign-in refused or recipient refused: failed with the reason, not retried', async () => {
    const auth = await startSmtp({ onAuth: (_a, _s, cb) => cb(new Error('Invalid username or password')) });
    const a = await setup(auth.port);
    await a.run();
    expect(a.apps.get(a.app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureCode: 'EMAIL_FAILED' });
  });

  it('recipient refused at RCPT: failed with the reason', async () => {
    const s = await startSmtp({ onRcptTo: (_addr, _s, cb) => cb(Object.assign(new Error('No such user here'), { responseCode: 550 })) });
    const { apps, app, run } = await setup(s.port);
    await run();
    expect(apps.get(app.id)).toMatchObject({ status: 'APPLICATION_FAILED', failureReason: expect.stringMatching(/No such user/) });
    expect(s.received).toHaveLength(0);
  });

  it('a temporary refusal of the message (451): not sent, so it is retried', async () => {
    const s = await startSmtp({
      onData(stream, _s, cb) {
        stream.on('data', () => {});
        stream.on('end', () => cb(Object.assign(new Error('Try again later'), { responseCode: 451 })));
      },
    });
    const { apps, app, run } = await setup(s.port);
    await expect(run()).rejects.toThrow(/451|Try again/);
    expect(apps.sentEmails(app.id)[0].status).toBe('failed');
  });

  it('connection dropped after the message was transferred: "uncertain", never sent again', async () => {
    const s = await startSmtp({
      onData(stream, _session, cb) {
        let raw = '';
        stream.on('data', (c) => (raw += c));
        stream.on('end', () => {
          s.received.push(raw);
          // The message is here; the reply never reaches the client.
          for (const c of (smtp as unknown as { connections: Set<{ _socket: { destroy(): void } }> }).connections) c._socket.destroy();
          void cb;
        });
      },
    });
    const { apps, app, run } = await setup(s.port);
    await run();
    expect(apps.sentEmails(app.id)[0].status).toBe('uncertain');
    await run(2);
    await run(3);
    expect(s.received).toHaveLength(1);
    expect(apps.get(app.id)?.status).toBe('APPLYING');
  }, 30_000);

  it('no reply after the message was transferred (timeout): "uncertain", never sent again', async () => {
    const s = await startSmtp({
      onData(stream) {
        let raw = '';
        stream.on('data', (c) => (raw += c));
        stream.on('end', () => void s.received.push(raw)); // never answers
      },
    });
    const { apps, app, run } = await setup(s.port, 1500);
    await run();
    expect(apps.sentEmails(app.id)[0].status).toBe('uncertain');
    await run(2);
    expect(s.received).toHaveLength(1);
  }, 30_000);
});
