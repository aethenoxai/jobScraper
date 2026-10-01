'use client';

import { useState, useTransition } from 'react';
import { saveNotificationSettings, sendTestNotification, type NotificationSettingsResult } from '@/app/(app)/notifications/actions';
import { btn, btnPrimary, input } from '@/components/ui';
import { EVENT_LABELS, NOTIFICATION_EVENTS, type NotificationSettings } from '@/server/notifications/settings';
import { EnableBrowserNotifications, testBrowserNotification } from './browser-notifier';

type ChannelKey = 'browser' | 'desktop' | 'email' | 'telegram';
const CHANNELS: Array<{ key: ChannelKey; label: string }> = [
  { key: 'browser', label: 'Browser (while Job Scraper is open in a tab)' },
  { key: 'desktop', label: 'Desktop (system notifications from the worker)' },
  { key: 'email', label: 'Email' },
  { key: 'telegram', label: 'Telegram (with Approve/Skip buttons)' },
];

export interface ChannelDelivery {
  status: 'sent' | 'failed' | 'retrying';
  when: string;
  error: string | null;
}

export function NotificationSettingsForm({
  initial,
  status,
  deliveries,
  timeZone,
}: {
  initial: NotificationSettings;
  status: Record<string, string | null>;
  deliveries: Partial<Record<ChannelKey, ChannelDelivery | null>>;
  timeZone: string;
}) {
  const [saved, setSaved] = useState<NotificationSettingsResult | null>(null);
  const [saving, startSave] = useTransition();
  const [tests, setTests] = useState<Partial<Record<ChannelKey | 'inapp', NotificationSettingsResult>>>({});
  const [testing, startTest] = useTransition();
  const runTest = (key: ChannelKey | 'inapp') =>
    startTest(async () => {
      const result = key === 'browser' ? await testBrowserNotification() : await sendTestNotification(key);
      setTests((t) => ({ ...t, [key]: result }));
    });
  const tone = (ok: boolean) => (ok ? 'text-green-700 dark:text-green-400' : 'text-red-600');

  return (
    <div className="space-y-6">
      {/* Submitted by hand so a failed save keeps what was typed (form actions reset the form). */}
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startSave(async () => setSaved(await saveNotificationSettings(null, data)));
        }}
      >
        <fieldset className="space-y-3">
          <legend className="font-semibold">Channels</legend>
          <p className="text-sm text-neutral-500">The in-app inbox is always on.</p>
          {CHANNELS.map((c) => {
            const d = deliveries[c.key];
            const test = tests[c.key];
            return (
              <div key={c.key} className="space-y-1 text-sm" data-testid={`channel-${c.key}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name={`channel.${c.key}`} defaultChecked={initial.channels[c.key]} /> {c.label}
                  </label>
                  {status[c.key] && <span className="text-xs text-amber-700 dark:text-amber-400">{status[c.key]}</span>}
                  <button type="button" className="text-xs underline" disabled={testing} onClick={() => runTest(c.key)}>
                    Send test
                  </button>
                </div>
                {test && <p role="status" className={`text-xs ${tone(test.ok)}`}>{test.message}</p>}
                {d && (
                  <p className="text-xs text-neutral-500">
                    {d.status === 'sent' ? `Last sent ${d.when}.` : d.status === 'retrying' ? `Retrying (last try ${d.when}): ${d.error}` : `Last attempt failed ${d.when}: ${d.error}`}
                  </p>
                )}
              </div>
            );
          })}
          <EnableBrowserNotifications />
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-semibold">Notify me about</legend>
          {NOTIFICATION_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`event.${e}`} defaultChecked={initial.events[e] !== false} /> {EVENT_LABELS[e]}
            </label>
          ))}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 font-semibold">Quiet hours and email</legend>
          <label className="flex flex-col gap-1 text-sm">Quiet from<input type="time" name="quietStart" defaultValue={initial.quietHours?.start ?? ''} className={input} /></label>
          <label className="flex flex-col gap-1 text-sm">Quiet until<input type="time" name="quietEnd" defaultValue={initial.quietHours?.end ?? ''} className={input} /></label>
          <label className="flex flex-col gap-1 text-sm">Email notifications to<input type="email" name="emailTo" defaultValue={initial.emailTo ?? ''} placeholder="your profile email" className={input} /></label>
          <p className="text-xs text-neutral-500 sm:col-span-3">
            Quiet hours use this computer’s time zone ({timeZone}). During quiet hours, email, desktop and Telegram messages wait; the inbox still updates. Bursts of new jobs arrive as one summary.
          </p>
        </fieldset>
        <div className="flex items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={saving}>Save</button>
          {saved && <span role="status" className={`text-sm ${tone(saved.ok)}`}>{saved.message}</span>}
        </div>
      </form>
      <div className="flex items-center gap-3">
        <button type="button" className={btn} disabled={testing} onClick={() => runTest('inapp')}>Send a test to the inbox</button>
        {tests.inapp && <span className={`text-sm ${tone(tests.inapp.ok)}`}>{tests.inapp.message}</span>}
      </div>
    </div>
  );
}
