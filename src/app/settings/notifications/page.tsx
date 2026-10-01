import type { Metadata } from 'next';
import { NotificationSettingsForm } from '@/components/notifications/settings-form';
import { Card, PageHeader } from '@/components/ui';
import { getAppContext } from '@/server/context';
import { formatWhen, requestTime } from '@/lib/format';
import { channelSetupProblems } from '@/server/notifications/setup';
import { EXTERNAL_CHANNELS } from '@/server/notifications/dispatcher';

export const metadata: Metadata = { title: 'Notification settings' };

export const dynamic = 'force-dynamic';

export default function NotificationSettingsPage() {
  const { notifier } = getAppContext();
  const now = requestTime();
  const deliveries = Object.fromEntries(
    EXTERNAL_CHANNELS.map((c) => {
      const d = notifier.lastDelivery(c);
      return [c, d ? { status: d.status, when: formatWhen(d.at, now), error: d.error } : null];
    }),
  );
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status = channelSetupProblems(process.env);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Notifications" subtitle="Where Job Scraper tells you about new matching jobs and your applications." />
      <Card>
        <NotificationSettingsForm initial={notifier.settings()} status={status} deliveries={deliveries} timeZone={timeZone} />
      </Card>
      <Card title="Set up Telegram">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the steps. Copy the token it gives you.</li>
          <li>Add <code>TELEGRAM_BOT_TOKEN=&lt;token&gt;</code> to your <code>.env</code> file and restart Job Scraper.</li>
          <li>Open your new bot in Telegram and send <code>/start</code>. It replies with your chat id.</li>
          <li>Add <code>TELEGRAM_ALLOWED_CHAT_ID=&lt;chat id&gt;</code> to <code>.env</code>, restart, and enable Telegram above.</li>
        </ol>
        <p className="mt-2 text-sm text-neutral-500">Only that chat can approve or skip jobs. Messages contain job titles, companies and links to your local Job Scraper.</p>
      </Card>
    </div>
  );
}
