import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { notifications } from '../db/schema';
import { createQueue } from '../queue';
import { createSettings } from '../settings';
import { createNotifier, FLUSH_DELAY_MS, NOTIFY_FLUSH_TASK, NOTIFY_SEND_TASK } from './dispatcher';
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_SETTINGS_KEY, quietUntil } from './settings';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date(2026, 9, 1, 14, 0); // local 14:00
});
afterEach(() => t.cleanup());

function setup(over: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS> = {}) {
  const settings = createSettings(t.db);
  settings.set(NOTIFICATION_SETTINGS_KEY, { ...DEFAULT_NOTIFICATION_SETTINGS, channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, telegram: true, email: true }, ...over });
  const queue = createQueue(t.db, { now: () => clock });
  return { queue, notifier: createNotifier({ db: t.db, settings, queue, now: () => clock }) };
}
const msg = (n: number) => ({ title: `Job ${n}`, body: `Company ${n}`, link: `/feed/${n}`, payload: { matchId: n } });

describe('notifier', () => {
  it('records each channel once and queues one delayed send per external channel', () => {
    const { notifier, queue } = setup();
    notifier.notify('job.matched', 'match:1', msg(1));
    notifier.notify('job.matched', 'match:1', msg(1));
    notifier.notify('job.matched', 'match:2', msg(2));
    const rows = t.db.select().from(notifications).all();
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'email', 'inapp', 'inapp', 'telegram', 'telegram']);
    expect(rows.filter((r) => r.channel === 'inapp').every((r) => r.status === 'sent')).toBe(true);
    expect(rows.filter((r) => r.channel !== 'inapp').every((r) => r.status === 'pending')).toBe(true);
    expect(queue.counts(NOTIFY_FLUSH_TASK).pending).toBe(2);
    // Waits a little so a burst arriving from several matching tasks goes out together.
    expect(queue.claim('w', [NOTIFY_FLUSH_TASK])).toBeNull();
    clock = new Date(clock.getTime() + FLUSH_DELAY_MS);
    expect(queue.claim('w', [NOTIFY_FLUSH_TASK])?.payload).toMatchObject({ channel: expect.any(String) });
  });

  it('respects disabled channels and events', () => {
    const { notifier } = setup({ events: { 'job.matched': false } });
    notifier.notify('job.matched', 'match:1', msg(1));
    expect(t.db.select().from(notifications).all()).toHaveLength(0);
  });

  it('holds external channels during quiet hours, but not the in-app inbox', () => {
    const { notifier, queue } = setup({ quietHours: { start: '13:00', end: '08:00' } });
    notifier.notify('job.matched', 'match:1', msg(1));
    clock = new Date(2026, 9, 2, 7, 59);
    expect(queue.claim('w', [NOTIFY_FLUSH_TASK])).toBeNull();
    clock = new Date(2026, 9, 2, 8, 0);
    expect(queue.claim('w', [NOTIFY_FLUSH_TASK])).toBeTruthy();
    expect(notifier.unreadCount()).toBe(1);
  });

  it('lists the inbox newest first and marks items read', () => {
    const { notifier } = setup();
    notifier.notify('job.matched', 'match:1', msg(1));
    clock = new Date(clock.getTime() + 1000);
    notifier.notify('job.matched', 'match:2', msg(2));
    expect(notifier.inbox(10).map((n) => n.title)).toEqual(['Job 2', 'Job 1']);
    notifier.markRead(notifier.inbox(10)[0].id);
    expect(notifier.unreadCount()).toBe(1);
    notifier.markAllRead();
    expect(notifier.unreadCount()).toBe(0);
  });
});

describe('quietUntil', () => {
  it('handles windows that cross midnight', () => {
    const q = { start: '22:00', end: '07:30' };
    expect(quietUntil(new Date(2026, 9, 1, 23, 0), q)?.getHours()).toBe(7);
    expect(quietUntil(new Date(2026, 9, 1, 6, 0), q)?.getDate()).toBe(1);
    expect(quietUntil(new Date(2026, 9, 1, 12, 0), q)).toBeNull();
    expect(quietUntil(new Date(2026, 9, 1, 12, 0), null)).toBeNull();
  });

  it('sends a test notification to one channel at once, even if it is switched off or in quiet hours', () => {
    const { notifier, queue } = setup({ channels: { ...DEFAULT_NOTIFICATION_SETTINGS.channels, desktop: false }, quietHours: { start: '00:00', end: '23:59' } });
    const id = notifier.sendTest('desktop');
    expect(t.db.select().from(notifications).all().map((r) => r.channel)).toEqual(['desktop']);
    expect(queue.claim('w', [NOTIFY_SEND_TASK])?.payload).toEqual({ notificationId: id });
    expect(notifier.latestUnreadAfter(0)).toEqual([]);
  });

  it('reports the last delivery of a channel, including errors', () => {
    const { notifier } = setup();
    expect(notifier.lastDelivery('email')).toBeNull();
    const id = notifier.sendTest('email');
    notifier.markSent(id, 'Invalid login: 535 bad password for secret-pass-1');
    expect(notifier.lastDelivery('email')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Invalid login/) });
  });
});
