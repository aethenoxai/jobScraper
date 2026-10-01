import type { Metadata } from 'next';
import { TrackingSettingsForm } from '@/components/settings/tracking-forms';
import { Card, Notice, PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { mailboxConfig } from '@/server/tracking/mailbox';

export const metadata: Metadata = { title: 'Tracking settings' };

export const dynamic = 'force-dynamic';

export default function TrackingSettingsPage() {
  const { tracking, settings } = getAppContext();
  const s = tracking.settings();
  const status = tracking.status();
  const cfg = mailboxConfig(process.env, settings);
  const now = requestTime();
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Tracking" subtitle="Follow up after applying: replies from employers are linked to your applications. What was received is shown separately from what Job Scraper thinks it means." />
      <Card title="Inbox">
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400" data-testid="mailbox">
          {'error' in cfg ? `Not ready: ${cfg.error}` : `Reads ${cfg.user} on ${cfg.host}. Only emails that look like they’re about an application are opened, and only those are kept.`}
        </p>
        {status && <Notice tone={status.ok ? 'neutral' : 'red'}>{`Last check ${formatWhen(status.at, now)}: ${status.message}`}</Notice>}
        <div className="mt-3"><TrackingSettingsForm inboxEnabled={s.inboxEnabled} autoUpdate={s.autoUpdate} threshold={s.threshold} ready={!('error' in cfg)} /></div>
      </Card>
    </div>
  );
}
