import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { notifications } from '../db/schema';
import { createMailer } from '../email/mailer';
import { createLogger } from '../logging';
import { createQueue, RetryLaterError } from '../queue';
import { createSettings } from '../settings';
import { createNotifier, DIGEST_COOLDOWN_MS, FLUSH_DELAY_MS, FLUSH_MAX_ATTEMPTS, NOTIFY_FLUSH_TASK } from './dispatcher';
import { createNotifyFlushHandler } from './send';
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_SETTINGS_KEY, type NotificationSettings } from './settings';
import { TelegramError } from './telegram/client';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date(2026, 9, 1, 14, 0);
});
afterEach(() => t.cleanup());

function setup(over: Partial<NotificationSettings> = {}, telegramSend?: (text: string) => Promise<number>) {
  const settings = createSettings(t.db);
  const save = (o: Partial<NotificationSettings>) =>
    settings.set(NOTIFICATION_SETTINGS_KEY, { ...DEFAULT_NOTIFICATION_SETTINGS, channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, telegram: true }, emailTo: 'me@example.com', ...o });
  save(over);
  const queue = createQueue(t.db, { now: () => clock });
  const notifier = createNotifier({ db: t.db, settings, queue, now: () => clock });
  const telegram: Array<{ text: string; buttons?: unknown }> = [];
  const emails: string[] = [];
  const mailer = createMailer({ env: { SMTP_HOST: 'x', SMTP_USERNAME: 'bot@example.com', SMTP_PASSWORD: 'secret123' }, transport: nodemailer.createTransport({ jsonTransport: true }) });
  const sendMail = mailer.send;
  mailer.send = async (m) => (emails.push(`${m.subject}\n${m.text}`), sendMail(m));
  const flush = createNotifyFlushHandler({
    notifier,
    appUrl: 'http://127.0.0.1:3000',
    mailer,
    desktop: { notify: async () => {} },
    telegram: {
      client: { sendMessage: async (_chat: string, text: string, buttons?: unknown) => (telegram.push({ text, buttons }), telegramSend ? telegramSend(text) : 1) } as never,
      chatId: '777',
    },
    now: () => clock,
  });
  /** Runs every due flush task the way the worker does. */
  const run = async (attempt = 1) => {
    clock = new Date(clock.getTime() + FLUSH_DELAY_MS);
    for (let task = queue.claim('w', [NOTIFY_FLUSH_TASK]); task; task = queue.claim('w', [NOTIFY_FLUSH_TASK])) {
      try {
        await flush(task.payload, { taskId: task.id, attempt, log, signal: new AbortController().signal });
        queue.complete(task.id);
      } catch (e) {
        queue.fail(task.id, e);
        throw e;
      }
    }
  };
  const rows = (channel: string) => t.db.select().from(notifications).all().filter((r) => r.channel === channel);
  return { notifier, queue, telegram, emails, run, rows, save };
}

const match = (id: number, score: number, profileId = 1) => ({
  entityKey: `match:${id}`,
  message: { title: `New matching job: Role ${id} (${score}%)`, body: `Company ${id}`, link: `/feed/${id}`, payload: { matchId: id, profileId, score } },
});

describe('notify.flush', () => {
  it('sends a few notifications one by one, jobs with Approve/Skip buttons', async () => {
    const { notifier, telegram, run, rows } = setup();
    notifier.notifyMany('job.matched', [match(1, 90), match(2, 80)]);
    notifier.notify('source.failing', 'source:1', { title: 'Remotive keeps failing', body: 'HTTP 503', link: '/sources' });
    await run();
    expect(telegram.map((m) => m.text.split('\n')[0])).toEqual(['🔔 New matching job: Role 1 (90%)', '🔔 New matching job: Role 2 (80%)', '🔔 Remotive keeps failing']);
    expect(telegram[0].buttons).toEqual([[{ text: '✅ Approve', callbackData: 'a:1' }, { text: '⏭ Skip', callbackData: 's:1' }]]);
    expect(rows('telegram').every((r) => r.status === 'sent')).toBe(true);
  });

  it('turns a burst spread over many matching tasks into one digest with the best jobs', async () => {
    const { notifier, queue, telegram, run, rows } = setup();
    for (let task = 0; task < 4; task++) notifier.notifyMany('job.matched', Array.from({ length: 5 }, (_, i) => match(task * 5 + i, 60 + task * 5 + i)));
    expect(queue.counts(NOTIFY_FLUSH_TASK).pending).toBe(1);
    await run();
    expect(telegram).toHaveLength(1);
    const text = telegram[0].text;
    expect(text).toMatch(/20 new matching jobs/);
    expect(text).toContain('Role 19 (79%)');
    expect(text).not.toContain('Role 0 ');
    expect(text).toMatch(/and 15 more/);
    expect(text).toContain('http://127.0.0.1:3000/feed?profile=1&fresh=new');
    expect(rows('telegram').filter((r) => r.status !== 'sent')).toHaveLength(0);
    expect(notifier.inbox(50)).toHaveLength(20);
  });

  it('after a digest, waits before sending the next batch', async () => {
    const { notifier, queue, run } = setup();
    notifier.notifyMany('job.matched', Array.from({ length: 6 }, (_, i) => match(i, 70)));
    await run();
    const sentAt = clock.getTime();
    notifier.notify('job.matched', 'match:99', match(99, 90).message);
    const next = t.db.select().from((await import('../db/schema')).queueTasks).all().find((x) => x.type === NOTIFY_FLUSH_TASK && x.status === 'pending')!;
    expect(next.runAt.getTime()).toBeGreaterThanOrEqual(sentAt + DIGEST_COOLDOWN_MS);
    expect(queue.counts(NOTIFY_FLUSH_TASK).pending).toBe(1);
  });

  it('re-checks settings when sending: quiet hours wait, channels switched off are not used', async () => {
    const { notifier, telegram, run, rows, save } = setup();
    notifier.notify('job.matched', 'match:1', match(1, 90).message);
    save({ quietHours: { start: '14:00', end: '18:00' } });
    await expect(run()).rejects.toBeInstanceOf(RetryLaterError);
    expect(telegram).toHaveLength(0);
    save({ channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, telegram: false } });
    clock = new Date(2026, 9, 1, 18, 1);
    await run();
    expect(telegram).toHaveLength(0);
    expect(rows('telegram')[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/turned off/i) });
  });

  it('fails a channel that is not set up with a clear message, without retrying', async () => {
    const { notifier, run, rows } = setup({ channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, email: true, telegram: true }, emailTo: null });
    notifier.notify('source.failing', 'source:1', { title: 'Remotive keeps failing', body: 'HTTP 503' });
    await run();
    expect(rows('email')[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/email address/i) });
    expect(rows('telegram')[0].status).toBe('sent');
  });

  it('waits as long as Telegram asks when rate limited, and retries other failures', async () => {
    let fail: Error | null = new TelegramError('Too Many Requests: retry after 30', 429, 30);
    const { notifier, run, rows } = setup({}, async () => {
      if (fail) throw fail;
      return 1;
    });
    notifier.notify('job.matched', 'match:1', match(1, 90).message);
    const limited = await run().catch((e) => e);
    expect(limited).toBeInstanceOf(RetryLaterError);
    expect((limited as RetryLaterError).delayMs).toBe(30_000);
    fail = new Error('socket hang up');
    await expect(run()).rejects.toThrow(/socket hang up/);
    expect(rows('telegram')[0]).toMatchObject({ status: 'pending', error: expect.stringMatching(/socket/) });
    fail = null;
    await run();
    expect(rows('telegram')[0]).toMatchObject({ status: 'sent', error: null });
  });

  it('gives up on the last attempt and says so', async () => {
    const { notifier, run, rows } = setup({}, async () => {
      throw new Error('network down');
    });
    notifier.notify('job.matched', 'match:1', match(1, 90).message);
    await expect(run(FLUSH_MAX_ATTEMPTS)).rejects.toThrow();
    expect(rows('telegram')[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/network down/) });
  });

  it('a message Telegram refuses outright (4xx) fails on its own, without holding up the others', async () => {
    const { notifier, run, rows, telegram } = setup({}, async (text) => {
      if (text.includes('Role 1')) throw new TelegramError("Bad Request: can't parse entities", 400);
      return 1;
    });
    notifier.notify('job.matched', 'match:1', match(1, 90).message);
    notifier.notify('job.matched', 'match:2', match(2, 80).message);
    await run();
    expect(telegram.map((m) => m.text.split('\n')[0])).toEqual(['🔔 New matching job: Role 1 (90%)', '🔔 New matching job: Role 2 (80%)']);
    const [first, second] = rows('telegram');
    expect(first).toMatchObject({ status: 'failed', error: expect.stringMatching(/parse entities/) });
    expect(second.status).toBe('sent');
  });

  it('a digest that failed to send is not counted as a job in the next one (round 2)', async () => {
    let failures = 2;
    const { notifier, run, telegram } = setup({}, async () => {
      if (failures-- > 0) throw new Error('socket hang up');
      return 1;
    });
    for (let i = 1; i <= 6; i++) notifier.notify('job.matched', `match:${i}`, match(i, 90 - i).message);
    await run().catch(() => {});
    await run(2).catch(() => {});
    await run(3);
    expect(telegram.at(-1)?.text.split('\n')[0]).toMatch(/6 new matching jobs/);
  });

  it('a digest left "pending" by a crash is closed at the next send (round 3)', async () => {
    const { notifier, run, rows } = setup();
    const leftover = notifier.recordDigest('telegram', 'job.matched', { title: '6 new matching jobs', body: 'b' });
    notifier.notify('job.matched', 'match:1', match(1, 90).message);
    await run();
    expect(rows('telegram').find((r) => r.id === leftover)).toMatchObject({ status: 'failed' });
  });

  it('a notification recorded while its channel is being sent goes out with the next send (final review I1)', async () => {
    let notifier: ReturnType<typeof setup>['notifier'] | null = null;
    const s = setup({}, async (text) => {
      if (text.includes('Applied A')) notifier!.notify('application.applied', 'app:b', { title: 'Applied B', body: 'b' });
      return 1;
    });
    notifier = s.notifier;
    s.notifier.notify('application.applied', 'app:a', { title: 'Applied A', body: 'a' });
    await s.run().catch((e) => expect(e).toBeInstanceOf(RetryLaterError));
    await s.run();
    expect(s.telegram.map((m) => m.text)).toEqual([expect.stringContaining('Applied A'), expect.stringContaining('Applied B')]);
    expect(s.rows('telegram').every((r) => r.status === 'sent')).toBe(true);
  });
});
