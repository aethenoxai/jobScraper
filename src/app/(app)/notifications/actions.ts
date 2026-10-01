'use server';

import { revalidatePath } from 'next/cache';
import { getAppContext } from '@/server/context';
import { z } from 'zod';
import { NOTIFICATION_EVENTS, NOTIFICATION_SETTINGS_KEY, NotificationSettingsSchema } from '@/server/notifications/settings';
import { channelSetupProblems } from '@/server/notifications/setup';

export async function markNotificationRead(id: number): Promise<void> {
  getAppContext().notifier.markRead(id);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead(): Promise<void> {
  getAppContext().notifier.markAllRead();
  revalidatePath('/notifications');
}

export interface NotificationSettingsResult {
  ok: boolean;
  message: string;
}

const FIELD_LABELS: Record<string, string> = {
  emailTo: '“Email notifications to” is not a valid email address',
  'quietHours.start': '“Quiet from” must be a time like 22:00',
  'quietHours.end': '“Quiet until” must be a time like 07:00',
};

export async function saveNotificationSettings(_prev: NotificationSettingsResult | null, formData: FormData): Promise<NotificationSettingsResult> {
  const on = (k: string) => formData.get(k) === 'on';
  const text = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? null : v;
  };
  const start = text('quietStart');
  const end = text('quietEnd');
  if (!!start !== !!end) return { ok: false, message: 'Set both “Quiet from” and “Quiet until”, or leave both empty.' };
  const parsed = NotificationSettingsSchema.safeParse({
    channels: { inapp: true, browser: on('channel.browser'), desktop: on('channel.desktop'), email: on('channel.email'), telegram: on('channel.telegram') },
    events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, on(`event.${e}`)])),
    quietHours: start && end ? { start, end } : null,
    emailTo: text('emailTo'),
  });
  if (!parsed.success) {
    const problems = [...new Set(parsed.error.issues.map((i) => FIELD_LABELS[i.path.join('.')] ?? 'Some settings are not valid'))];
    return { ok: false, message: `${problems.join('. ')}.` };
  }
  getAppContext().settings.set(NOTIFICATION_SETTINGS_KEY, parsed.data);
  revalidatePath('/settings/notifications');
  // Saved either way (the .env file may be edited next), but a channel switched on that can't send is said out loud.
  const problems = channelSetupProblems(process.env);
  const notReady = (['email', 'telegram'] as const).filter((c) => parsed.data.channels[c] && problems[c]).map((c) => `${c === 'email' ? 'Email' : 'Telegram'} is on but can’t send yet: ${problems[c]!.replace(/\.?$/, '.')}`);
  return { ok: true, message: ['Notification settings saved.', ...notReady].join(' ') };
}

const TestChannel = z.enum(['inapp', 'desktop', 'email', 'telegram']);
const CHANNEL_NAMES = { inapp: 'inbox', desktop: 'desktop', email: 'email', telegram: 'Telegram' } as const;

/** Sends a test and waits briefly for the worker's result, so problems show up right here. */
export async function sendTestNotification(channel: string): Promise<NotificationSettingsResult> {
  const parsed = TestChannel.safeParse(channel);
  if (!parsed.success) return { ok: false, message: 'Unknown channel.' };
  const { notifier } = getAppContext();
  const id = notifier.sendTest(parsed.data);
  const name = CHANNEL_NAMES[parsed.data];
  if (parsed.data === 'inapp') {
    revalidatePath('/notifications');
    return { ok: true, message: 'Test added to your inbox.' };
  }
  for (let waited = 0; waited < 12_000; waited += 400) {
    const n = notifier.get(id);
    if (n?.status === 'sent') return { ok: true, message: `Test sent to ${name}.` };
    if (n?.status === 'failed') return { ok: false, message: `The ${name} test failed: ${n.error ?? 'unknown error'}` };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, message: `The ${name} test is queued but hasn't been sent yet. Is the Job Scraper worker running?` };
}
