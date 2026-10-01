'use server';

import { revalidatePath } from 'next/cache';
import { getAppContext } from '@/server/context';
import { mailboxConfig } from '@/server/tracking/mailbox';
import { INBOX_POLL_TASK } from '@/server/tracking/poll';
import { TRACKING_SETTINGS_KEY, TrackingSettingsSchema } from '@/server/tracking/service';

export interface TrackingActionResult {
  ok: boolean;
  message: string;
}

export async function saveTrackingSettingsAction(_prev: TrackingActionResult | null, formData: FormData): Promise<TrackingActionResult> {
  const parsed = TrackingSettingsSchema.safeParse({ inboxEnabled: formData.get('inboxEnabled') === 'on', autoUpdate: formData.get('autoUpdate') === 'on', threshold: Number(formData.get('threshold')) / 100 });
  if (!parsed.success) return { ok: false, message: 'The confidence threshold must be between 50 and 100.' };
  const { settings, queue } = getAppContext();
  const cfg = mailboxConfig(process.env, settings);
  // Turning it on without a mailbox would only fail every 15 minutes: say what's missing now.
  if (parsed.data.inboxEnabled && 'error' in cfg) return { ok: false, message: `Inbox tracking can’t be turned on yet. ${cfg.error}` };
  settings.set(TRACKING_SETTINGS_KEY, parsed.data);
  if (parsed.data.inboxEnabled) queue.enqueue(INBOX_POLL_TASK, {}, { dedupeKey: INBOX_POLL_TASK });
  revalidatePath('/settings/tracking');
  return { ok: true, message: parsed.data.inboxEnabled ? 'Saved. Checking your inbox now, then every 15 minutes.' : 'Saved.' };
}

export async function checkInboxNowAction(): Promise<TrackingActionResult> {
  const { tracking, queue, settings } = getAppContext();
  const cfg = mailboxConfig(process.env, settings);
  if ('error' in cfg) return { ok: false, message: cfg.error };
  if (!tracking.settings().inboxEnabled) return { ok: false, message: 'Turn on inbox tracking first.' };
  queue.enqueue(INBOX_POLL_TASK, {}, { dedupeKey: INBOX_POLL_TASK });
  return { ok: true, message: 'Checking your inbox… refresh this page in a minute to see the result.' };
}
