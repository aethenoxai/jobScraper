import { getAppContext } from '@/server/context';

export const dynamic = 'force-dynamic';

/** New unread in-app notifications after ?after=<id>, for browser pop-ups. */
export function GET(req: Request) {
  const after = Number(new URL(req.url).searchParams.get('after')) || 0;
  const { notifier } = getAppContext();
  const s = notifier.settings();
  const items = notifier.latestUnreadAfter(after).map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link }));
  return Response.json({ browserEnabled: s.channels.browser, unread: notifier.unreadCount(), items });
}
