import { z } from 'zod';

export const NOTIFICATION_SETTINGS_KEY = 'notifications';
export const NOTIFICATION_EVENTS = ['job.matched', 'application.ready', 'application.applied', 'application.failed', 'application.reply', 'source.failing', 'budget.exhausted'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  'job.matched': 'New matching jobs',
  'application.ready': 'Application ready to review',
  'application.applied': 'Application submitted',
  'application.failed': 'Application failed or skipped',
  'application.reply': 'Reply from an employer',
  'source.failing': 'A job source keeps failing',
  'budget.exhausted': 'Daily AI budget reached',
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const NotificationSettingsSchema = z.object({
  channels: z.object({ inapp: z.boolean(), browser: z.boolean(), desktop: z.boolean(), email: z.boolean(), telegram: z.boolean() }),
  /** Per-event switch; events not listed are on. */
  events: z.record(z.string(), z.boolean()),
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable(),
  /** Where email notifications go (defaults to the default profile's email). */
  emailTo: z.string().trim().email().nullable(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  channels: { inapp: true, browser: true, desktop: false, email: false, telegram: false },
  events: {},
  quietHours: null,
  emailTo: null,
};

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** If `now` falls inside the quiet hours (local time), when they end; otherwise null. */
export function quietUntil(now: Date, quiet: NotificationSettings['quietHours']): Date | null {
  if (!quiet || quiet.start === quiet.end) return null;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!inside) return null;
  const until = new Date(now);
  until.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (until <= now) until.setDate(until.getDate() + 1);
  return until;
}
