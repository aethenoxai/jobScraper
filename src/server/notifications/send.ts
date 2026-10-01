import { z } from 'zod';
import type { Mailer } from '../email/mailer';
import { AUTOMATED_HEADER } from '../tracking/mailbox';
import { PermanentError, RetryLaterError } from '../queue';
import type { TaskHandler } from '../queue/runner';
import { DIGEST_THRESHOLD, FLUSH_DELAY_MS, FLUSH_MAX_ATTEMPTS, type ExternalChannel, type NotificationRecord, type Notifier } from './dispatcher';
import { EVENT_LABELS, quietUntil, type NotificationEvent } from './settings';
import { TelegramError, type Button, type TelegramClient } from './telegram/client';

export interface DesktopNotifier {
  notify(n: { title: string; message: string; open?: string }): Promise<void>;
}

/** node-notifier behind a promise, loaded lazily so the web bundle never needs it. */
export function createDesktopNotifier(): DesktopNotifier {
  return {
    async notify(n) {
      const { default: notifier } = await import('node-notifier');
      await new Promise<void>((resolve, reject) =>
        notifier.notify({ title: n.title, message: n.message, open: n.open, wait: false }, (err) =>
          err
            ? reject(/ENOENT|not found|notify-send/i.test(String(err.message)) ? new PermanentError('Desktop notifications need a notification service on this computer (on Linux, install libnotify / notify-send).') : err)
            : resolve(),
        ),
      );
    },
  };
}

export function formatTelegram(m: { title: string; body: string; link?: string | null }, appUrl: string): string {
  return `🔔 ${m.title}\n${m.body}${m.link ? `\n\n${appUrl}${m.link}` : ''}`;
}

const Payload = z.object({ notificationId: z.number().int() });
const FlushPayload = z.object({ channel: z.enum(['desktop', 'email', 'telegram']) });
const MatchPayload = z.object({ matchId: z.number().int(), profileId: z.number().int().optional(), score: z.number().optional() });
/** How many items a digest lists by name. */
const DIGEST_LIST = 5;

export interface SendDeps {
  notifier: Notifier;
  appUrl: string;
  mailer: Mailer;
  desktop: DesktopNotifier;
  telegram: { client: TelegramClient; chatId: string | null } | null;
  emailTo?: () => string | null;
  now?: () => Date;
}

type Message = Pick<NotificationRecord, 'channel' | 'event' | 'title' | 'body' | 'link' | 'payload'>;

/** Sends one message on one external channel. Missing setup is a PermanentError with what to do about it. */
async function deliver(deps: SendDeps, n: Message): Promise<void> {
  const url = n.link ? `${deps.appUrl}${n.link}` : deps.appUrl;
  if (n.channel === 'desktop') {
    await deps.desktop.notify({ title: n.title, message: n.body, open: url });
  } else if (n.channel === 'email') {
    const to = deps.notifier.settings().emailTo ?? deps.emailTo?.() ?? null;
    if (!to) throw new PermanentError('Set an email address for notifications in Settings → Notifications.');
    // The header lets inbox tracking recognise (and ignore) its own notifications when they arrive.
    await deps.mailer.send({ to, subject: `Job Scraper: ${n.title}`, text: `${n.body}\n\n${url}\n\n— Job Scraper (running on your computer)`, headers: { [AUTOMATED_HEADER]: 'notification' } });
  } else if (n.channel === 'telegram') {
    if (!deps.telegram || !deps.telegram.chatId) {
      throw new PermanentError('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID to your .env file.');
    }
    const match = MatchPayload.safeParse(n.payload);
    const buttons: Button[][] | undefined =
      n.event === 'job.matched' && match.success
        ? [[{ text: '✅ Approve', callbackData: `a:${match.data.matchId}` }, { text: '⏭ Skip', callbackData: `s:${match.data.matchId}` }]]
        : undefined;
    await deps.telegram.client.sendMessage(deps.telegram.chatId, formatTelegram(n, deps.appUrl), buttons);
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Telegram refused this message itself (bad text, chat gone): sending it again won't help, and it mustn't block the rest. */
const refused = (err: unknown) => err instanceof TelegramError && err.code !== null && err.code >= 400 && err.code < 500 && err.code !== 429;

/** Sends a single (test) notification right away. */
export function createNotifySendHandler(deps: SendDeps): TaskHandler {
  return async (payload) => {
    const parsed = Payload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid notify.send payload');
    const n = deps.notifier.get(parsed.data.notificationId);
    if (!n || n.status === 'sent' || n.channel === 'inapp' || n.channel === 'browser') return;
    try {
      await deliver(deps, n);
      deps.notifier.markSent(n.id);
    } catch (err) {
      deps.notifier.markSent(n.id, messageOf(err));
      throw err;
    }
  };
}

/** A digest for many waiting items of one kind: the best few by name, and a link to the rest. */
function digestOf(event: string, rows: NotificationRecord[]): Omit<Message, 'channel'> {
  const ranked = [...rows].sort((a, b) => (MatchPayload.safeParse(b.payload).data?.score ?? 0) - (MatchPayload.safeParse(a.payload).data?.score ?? 0));
  const lines = ranked.slice(0, DIGEST_LIST).map((r) => `• ${r.title.replace(/^New matching job: /, '')} — ${r.body.split(' · ')[0]}`);
  if (rows.length > DIGEST_LIST) lines.push(`…and ${rows.length - DIGEST_LIST} more`);
  if (event === 'job.matched') {
    const profileIds = new Set(rows.map((r) => MatchPayload.safeParse(r.payload).data?.profileId));
    const profile = profileIds.size === 1 ? [...profileIds][0] : undefined;
    return { event, title: `${rows.length} new matching jobs`, body: lines.join('\n'), link: `/feed?${profile ? `profile=${profile}&` : ''}fresh=new`, payload: null };
  }
  return { event, title: `${rows.length} notifications: ${EVENT_LABELS[event as NotificationEvent] ?? event}`, body: lines.join('\n'), link: '/notifications', payload: null };
}

/**
 * Sends everything waiting for one channel. Settings are read now (not when queued): quiet hours wait, a channel or
 * event switched off since is not used. More than DIGEST_THRESHOLD items of one kind go out as a single digest.
 */
export function createNotifyFlushHandler(deps: SendDeps): TaskHandler {
  const now = deps.now ?? (() => new Date());
  return async (payload, ctx) => {
    const parsed = FlushPayload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid notify.flush payload');
    const channel: ExternalChannel = parsed.data.channel;
    deps.notifier.closeLeftoverDigests(channel);
    const s = deps.notifier.settings();
    let rows = deps.notifier.pending(channel);
    if (!rows.length) return;
    if (!s.channels[channel]) {
      deps.notifier.markManyFailed(rows.map((r) => r.id), 'Not sent: this channel was turned off.');
      return;
    }
    const off = rows.filter((r) => s.events[r.event] === false);
    deps.notifier.markManyFailed(off.map((r) => r.id), 'Not sent: this kind of notification was turned off.');
    rows = rows.filter((r) => s.events[r.event] !== false);
    const quiet = quietUntil(now(), s.quietHours);
    if (quiet) throw new RetryLaterError(quiet.getTime() - now().getTime(), 'Quiet hours');

    const groups = new Map<string, NotificationRecord[]>();
    for (const r of rows) groups.set(r.event, [...(groups.get(r.event) ?? []), r]);
    let current: NotificationRecord[] = [];
    try {
      for (const [event, items] of groups) {
        current = items;
        if (items.length > DIGEST_THRESHOLD) {
          const digest = { channel, ...digestOf(event, items) };
          const id = deps.notifier.recordDigest(channel, event, { ...digest, link: digest.link ?? undefined });
          try {
            await deliver(deps, digest);
          } catch (err) {
            if (!refused(err)) {
              // This digest is done with; its items stay waiting and go into the next one.
              deps.notifier.markManyFailed([id], `Not sent (${messageOf(err)}); its notifications go out with the next send.`);
              throw err;
            }
            deps.notifier.markManyFailed([id, ...items.map((i) => i.id)], messageOf(err));
            continue;
          }
          deps.notifier.markSent(id);
          deps.notifier.markManySent(items.map((i) => i.id));
        } else {
          for (const item of items) {
            current = [item];
            try {
              await deliver(deps, item);
            } catch (err) {
              if (!refused(err)) throw err;
              deps.notifier.markManyFailed([item.id], messageOf(err));
              continue;
            }
            deps.notifier.markSent(item.id);
          }
        }
      }
    } catch (err) {
      const message = messageOf(err);
      const left = deps.notifier.pending(channel);
      if (err instanceof PermanentError || ctx.attempt >= FLUSH_MAX_ATTEMPTS) {
        // Not set up, or out of retries: say so on every waiting notification and stop.
        deps.notifier.markManyFailed(left.map((r) => r.id), message);
        if (err instanceof PermanentError) return;
        throw err;
      }
      for (const r of current) deps.notifier.noteError(r.id, message);
      if (err instanceof TelegramError && err.retryAfterSec) throw new RetryLaterError(err.retryAfterSec * 1000, message);
      throw err;
    }
    // Recorded while this send ran: its own send couldn't be queued (this one held the slot), so go round again.
    if (deps.notifier.pending(channel).length) throw new RetryLaterError(FLUSH_DELAY_MS, 'More notifications arrived while sending');
  };
}
