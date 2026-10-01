import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, notLike, or } from 'drizzle-orm';
import type { Db } from '../db';
import { notifications, NOTIFICATION_CHANNELS } from '../db/schema';
import { scrubSecrets } from '../logging';
import type { Queue } from '../queue';
import type { SettingsStore } from '../settings';
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_SETTINGS_KEY, NotificationSettingsSchema, quietUntil, type NotificationEvent, type NotificationSettings } from './settings';

/** Sends one notification right away (tests from the settings page). */
export const NOTIFY_SEND_TASK = 'notify.send';
/** Sends everything waiting for one external channel, as single messages or one digest. */
export const NOTIFY_FLUSH_TASK = 'notify.flush';
/** How long a channel collects notifications before sending, so bursts from many tasks go out together. */
export const FLUSH_DELAY_MS = 2 * 60_000;
/** After a digest, the channel waits this long before the next send. */
export const DIGEST_COOLDOWN_MS = 15 * 60_000;
export const FLUSH_MAX_ATTEMPTS = 8;
/** More than this many waiting items of one kind become a single digest on external channels. */
export const DIGEST_THRESHOLD = 5;

export type Channel = (typeof NOTIFICATION_CHANNELS)[number];
export type ExternalChannel = 'desktop' | 'email' | 'telegram';
export const EXTERNAL_CHANNELS: ExternalChannel[] = ['desktop', 'email', 'telegram'];
const isExternal = (c: Channel): c is ExternalChannel => (EXTERNAL_CHANNELS as Channel[]).includes(c);

export interface NotifyMessage {
  title: string;
  body: string;
  /** In-app path, e.g. "/feed/12". */
  link?: string;
  /** Extra data for channels, e.g. { matchId, profileId, score } for Telegram buttons and digests. */
  payload?: unknown;
}

export type NotificationRecord = typeof notifications.$inferSelect;

export interface Delivery {
  status: 'sent' | 'failed' | 'retrying';
  at: Date;
  title: string;
  error: string | null;
}

export function createNotifier(deps: { db: Db; settings: SettingsStore; queue: Queue; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const readSettings = (): NotificationSettings => deps.settings.get(NOTIFICATION_SETTINGS_KEY, NotificationSettingsSchema, DEFAULT_NOTIFICATION_SETTINGS);

  /** Stores the notification for a channel; false when it was already recorded (same event, entity and channel). */
  function record(event: string, entityKey: string, channel: Channel, message: NotifyMessage): number | null {
    const t = now();
    const row = db
      .insert(notifications)
      .values({ event, entityKey, channel, title: message.title, body: message.body, link: message.link ?? null, payload: message.payload ?? null, status: isExternal(channel) ? 'pending' : 'sent', createdAt: t, sentAt: isExternal(channel) ? null : t })
      .onConflictDoNothing()
      .returning({ id: notifications.id })
      .get();
    return row?.id ?? null;
  }

  function lastDigestAt(channel: ExternalChannel): Date | null {
    return (
      db
        .select({ at: notifications.sentAt })
        .from(notifications)
        .where(and(eq(notifications.channel, channel), like(notifications.entityKey, 'digest:%'), eq(notifications.status, 'sent')))
        .orderBy(desc(notifications.sentAt))
        .limit(1)
        .get()?.at ?? null
    );
  }

  /** One flush per channel collects everything recorded meanwhile; quiet hours and digest cool-down push it later. */
  function scheduleFlush(channel: ExternalChannel, s: NotificationSettings): void {
    const t = now();
    const times = [t.getTime() + FLUSH_DELAY_MS, (lastDigestAt(channel)?.getTime() ?? 0) + DIGEST_COOLDOWN_MS, quietUntil(t, s.quietHours)?.getTime() ?? 0];
    deps.queue.enqueue(NOTIFY_FLUSH_TASK, { channel }, { runAt: new Date(Math.max(...times)), dedupeKey: `${NOTIFY_FLUSH_TASK}:${channel}`, maxAttempts: FLUSH_MAX_ATTEMPTS });
  }

  const enabledChannels = (s: NotificationSettings, event: string): Channel[] =>
    s.events[event] === false ? [] : (['inapp', ...EXTERNAL_CHANNELS] as Channel[]).filter((c) => s.channels[c]);

  function recordAll(event: NotificationEvent, items: Array<{ entityKey: string; message: NotifyMessage }>): void {
    const s = readSettings();
    for (const channel of enabledChannels(s, event)) {
      let added = false;
      for (const item of items) added = record(event, item.entityKey, channel, item.message) !== null || added;
      if (added && isExternal(channel)) scheduleFlush(channel, s);
    }
  }

  return {
    settings: readSettings,

    /** Records the notification for every enabled channel (once per event + entity + channel). */
    notify(event: NotificationEvent, entityKey: string, message: NotifyMessage): void {
      recordAll(event, [{ entityKey, message }]);
    },

    /** Like notify for many items. The inbox lists each one; external channels digest bursts when they send. */
    notifyMany(event: NotificationEvent, items: Array<{ entityKey: string; message: NotifyMessage }>): void {
      if (items.length) recordAll(event, items);
    },

    /** A test message for one channel (settings page): sent at once, even if the channel is off or it's quiet hours. */
    sendTest(channel: 'inapp' | ExternalChannel): number {
      const t = now();
      const id = record('test', `test:${channel}:${t.getTime()}`, channel, { title: 'Test notification', body: 'Notifications from Job Scraper reach you here.', link: '/notifications' })!;
      if (isExternal(channel)) deps.queue.enqueue(NOTIFY_SEND_TASK, { notificationId: id }, { dedupeKey: `${NOTIFY_SEND_TASK}:${id}` });
      return id;
    },

    /** Notifications waiting to be sent on a channel, oldest first. */
    pending(channel: ExternalChannel): NotificationRecord[] {
      // Digest rows are messages about other notifications, never items themselves.
      return db.select().from(notifications).where(and(eq(notifications.channel, channel), eq(notifications.status, 'pending'), notLike(notifications.entityKey, 'digest:%'))).orderBy(asc(notifications.id)).all();
    },

    /**
     * Closes digests a crash left unsent (their items are still waiting and go into the next digest). Only one send
     * per channel runs at a time, so any pending digest when a send starts is a leftover.
     */
    closeLeftoverDigests(channel: ExternalChannel): void {
      db.update(notifications)
        .set({ status: 'failed', error: 'Interrupted before it was confirmed as sent; its notifications went out with a later send.' })
        .where(and(eq(notifications.channel, channel), eq(notifications.status, 'pending'), like(notifications.entityKey, 'digest:%')))
        .run();
    },

    /** Records a digest message (sent by the flush, which then marks the items it covers). */
    recordDigest(channel: ExternalChannel, event: string, message: NotifyMessage): number {
      return record(event, `digest:${event}:${now().getTime()}:${Math.random().toString(36).slice(2, 8)}`, channel, message)!;
    },

    /** Marks a notification sent, or failed with an error (shown on the settings page). */
    markSent(id: number, error?: string): void {
      db.update(notifications)
        .set(error ? { status: 'failed', error: scrubSecrets(error).slice(0, 500) } : { status: 'sent', sentAt: now(), error: null })
        .where(eq(notifications.id, id))
        .run();
    },

    markManySent(ids: number[]): void {
      if (ids.length) db.update(notifications).set({ status: 'sent', sentAt: now(), error: null }).where(inArray(notifications.id, ids)).run();
    },

    markManyFailed(ids: number[], error: string): void {
      if (ids.length) db.update(notifications).set({ status: 'failed', error: scrubSecrets(error).slice(0, 500) }).where(inArray(notifications.id, ids)).run();
    },

    /** Keeps a notification waiting but notes why the last try failed. */
    noteError(id: number, error: string): void {
      db.update(notifications).set({ error: scrubSecrets(error).slice(0, 500) }).where(eq(notifications.id, id)).run();
    },

    /** The most recent delivery outcome of a channel, for the settings page. */
    lastDelivery(channel: ExternalChannel): Delivery | null {
      const row = db
        .select()
        .from(notifications)
        .where(and(eq(notifications.channel, channel), or(inArray(notifications.status, ['sent', 'failed']), isNotNull(notifications.error))))
        .orderBy(desc(notifications.id))
        .limit(1)
        .get();
      if (!row) return null;
      return { status: row.status === 'pending' ? 'retrying' : (row.status as 'sent' | 'failed'), at: row.sentAt ?? row.createdAt, title: row.title, error: row.error };
    },

    /** Unread in-app notifications newer than an id (for browser notifications). */
    latestUnreadAfter(afterId: number): NotificationRecord[] {
      return db
        .select()
        .from(notifications)
        .where(and(eq(notifications.channel, 'inapp'), isNull(notifications.readAt), gt(notifications.id, afterId)))
        .orderBy(desc(notifications.id))
        .limit(10)
        .all();
    },

    get(id: number): NotificationRecord | null {
      return db.select().from(notifications).where(eq(notifications.id, id)).get() ?? null;
    },

    inbox(limit = 50, offset = 0): NotificationRecord[] {
      return db.select().from(notifications).where(eq(notifications.channel, 'inapp')).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit).offset(offset).all();
    },

    unreadCount(): number {
      return db.select({ n: count() }).from(notifications).where(and(eq(notifications.channel, 'inapp'), isNull(notifications.readAt))).get()?.n ?? 0;
    },

    markRead(id: number): void {
      db.update(notifications).set({ readAt: now() }).where(and(eq(notifications.id, id), isNull(notifications.readAt))).run();
    },

    markAllRead(): void {
      db.update(notifications).set({ readAt: now() }).where(and(eq(notifications.channel, 'inapp'), isNull(notifications.readAt))).run();
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
