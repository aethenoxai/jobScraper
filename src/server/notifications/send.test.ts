import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createMailer } from '../email/mailer';
import { createLogger } from '../logging';
import { createQueue, PermanentError } from '../queue';
import { createSettings } from '../settings';
import { createNotifier, NOTIFY_SEND_TASK } from './dispatcher';
import { createNotifySendHandler, formatTelegram } from './send';
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_SETTINGS_KEY } from './settings';

const log = createLogger({ level: 'silent' });
const ctx = { taskId: 1, attempt: 1, log, signal: new AbortController().signal };
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function setup(channels: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS.channels>, emailTo: string | null = 'me@example.com') {
  const settings = createSettings(t.db);
  settings.set(NOTIFICATION_SETTINGS_KEY, { ...DEFAULT_NOTIFICATION_SETTINGS, channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, ...channels }, emailTo });
  const queue = createQueue(t.db);
  const notifier = createNotifier({ db: t.db, settings, queue });
  const sent: Record<string, unknown[]> = { desktop: [], telegram: [] };
  const mailer = createMailer({ env: { SMTP_HOST: 'x', SMTP_USERNAME: 'bot@example.com', SMTP_PASSWORD: 'secret123' }, transport: nodemailer.createTransport({ jsonTransport: true }) });
  const handler = createNotifySendHandler({
    notifier,
    appUrl: 'http://127.0.0.1:3000',
    mailer,
    desktop: { notify: async (n) => void sent.desktop.push(n) },
    telegram: { client: { sendMessage: async (chat: string, text: string, buttons?: unknown) => (sent.telegram.push({ chat, text, buttons }), 1) } as never, chatId: '777' },
  });
  const run = async () => {
    for (let task = queue.claim('w', [NOTIFY_SEND_TASK]); task; task = queue.claim('w', [NOTIFY_SEND_TASK])) {
      try {
        await handler(task.payload, ctx);
        queue.complete(task.id);
      } catch (e) {
        queue.fail(task.id, e);
      }
    }
  };
  return { notifier, sent, run, queue };
}

describe('notify.send (tests from the settings page)', () => {
  it('delivers a test to desktop, email and Telegram right away and marks it sent', async () => {
    const { notifier, sent, run } = setup({});
    notifier.sendTest('desktop');
    notifier.sendTest('telegram');
    notifier.sendTest('email');
    await run();
    expect(sent.desktop).toHaveLength(1);
    expect(sent.telegram[0]).toMatchObject({ chat: '777' });
    expect((sent.telegram[0] as { text: string }).text).toContain('http://127.0.0.1:3000/notifications');
    expect(['desktop', 'telegram', 'email'].map((c) => notifier.lastDelivery(c as never)?.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it('records a clear failure when email has no recipient', async () => {
    const { notifier, run } = setup({}, null);
    notifier.sendTest('email');
    await run();
    expect(notifier.lastDelivery('email')).toMatchObject({ status: 'failed', error: expect.stringMatching(/email address/i) });
  });

  it('formats Telegram messages as plain text with a link', () => {
    expect(formatTelegram({ title: 'T', body: 'B', link: '/feed/1' }, 'http://127.0.0.1:3000')).toBe('🔔 T\nB\n\nhttp://127.0.0.1:3000/feed/1');
  });

  it('treats a missing Telegram setup as a permanent problem', async () => {
    const settings = createSettings(t.db);
    const queue = createQueue(t.db);
    const notifier = createNotifier({ db: t.db, settings, queue });
    notifier.sendTest('telegram');
    const handler = createNotifySendHandler({ notifier, appUrl: 'http://x', mailer: createMailer({ env: {} }), desktop: { notify: async () => {} }, telegram: null });
    const task = queue.claim('w', [NOTIFY_SEND_TASK])!;
    await expect(handler(task.payload, ctx)).rejects.toBeInstanceOf(PermanentError);
    expect(notifier.lastDelivery('telegram')).toMatchObject({ status: 'failed', error: expect.stringMatching(/TELEGRAM_BOT_TOKEN/) });
  });

  it('treats missing SMTP settings as a permanent problem', async () => {
    const mailer = createMailer({ env: {} });
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(PermanentError);
  });
});
