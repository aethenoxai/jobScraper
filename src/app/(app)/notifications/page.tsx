import type { Metadata } from 'next';
import Link from 'next/link';
import { PollNow } from '@/components/notifications/browser-notifier';
import { btn, Card, PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { markAllNotificationsRead, markNotificationRead } from './actions';

export const metadata: Metadata = { title: 'Inbox' };

export const dynamic = 'force-dynamic';

export default function NotificationsPage() {
  const { notifier } = getAppContext();
  const items = notifier.inbox(100);
  const now = requestTime();
  return (
    <div className="max-w-3xl space-y-5">
      <PollNow version={notifier.unreadCount()} />
      <PageHeader
        title="Inbox"
        subtitle={<span>Everything Job Scraper told you about. Choose where else you are notified in <Link href="/settings/notifications" className="underline">notification settings</Link>.</span>}
        actions={<form action={markAllNotificationsRead}><button className={btn}>Mark all as read</button></form>}
      />
      <Card>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">No notifications yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {items.map((n) => (
              <li key={n.id} className={`flex items-start justify-between gap-3 py-3 ${n.readAt ? 'opacity-60' : ''}`} data-testid="notification">
                <div>
                  <div className="font-medium">{n.link ? <Link href={n.link} className="hover:underline">{n.title}</Link> : n.title}</div>
                  <div className="text-sm text-neutral-600 dark:text-neutral-400">{n.body}</div>
                  <div className="text-xs text-neutral-500">{formatWhen(n.createdAt, now)}</div>
                </div>
                {!n.readAt && (
                  <form action={markNotificationRead.bind(null, n.id)}><button className="text-xs underline">Mark read</button></form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
