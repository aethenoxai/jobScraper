'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const UNREAD_EVENT = 'js:unread';
const POLL_EVENT = 'js:poll';
const LAST_KEY = 'js.lastNotified';

/** Storage can be blocked (private mode, strict settings); notifications must never break the page. */
function readLast(): number {
  try {
    return Number(sessionStorage.getItem(LAST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeLast(id: number): void {
  try {
    sessionStorage.setItem(LAST_KEY, String(id));
  } catch {
    // keep going without remembering
  }
}

/**
 * Polls for new in-app notifications: keeps the inbox badge current and, while Job Scraper is open in a tab,
 * shows them as browser notifications. Polls again on every page change.
 */
export function BrowserNotifier() {
  const pathname = usePathname();
  useEffect(() => {
    let lastId = readLast();
    let first = lastId === 0;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/notifications/unread?after=${lastId}`, { cache: 'no-store' });
        const data = (await res.json()) as { browserEnabled: boolean; unread: number; items: Array<{ id: number; title: string; body: string; link: string | null }> };
        if (stopped) return;
        window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: data.unread }));
        if (data.items.length) {
          lastId = Math.max(lastId, ...data.items.map((i) => i.id));
          writeLast(lastId);
        }
        // Don't replay old notifications when the tab first opens.
        if (!first && data.browserEnabled && 'Notification' in window && Notification.permission === 'granted') {
          for (const item of data.items.slice(0, 3)) {
            const n = new Notification(item.title, { body: item.body, tag: `js-${item.id}` });
            n.onclick = () => {
              window.focus();
              if (item.link) window.location.href = item.link;
            };
          }
        }
        first = false;
      } catch {
        // offline or server restarting: try again next tick
      }
    };
    void tick();
    const timer = setInterval(tick, 20_000);
    const now = () => void tick();
    window.addEventListener(POLL_EVENT, now);
    window.addEventListener('focus', now);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(POLL_EVENT, now);
      window.removeEventListener('focus', now);
    };
  }, [pathname]);
  return null;
}

/** The unread count next to "Inbox", kept current by BrowserNotifier. */
export function InboxBadge() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setUnread(Number((e as CustomEvent<number>).detail) || 0);
    window.addEventListener(UNREAD_EVENT, on);
    return () => window.removeEventListener(UNREAD_EVENT, on);
  }, []);
  return unread > 0 ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white" data-testid="unread-badge">{unread}</span> : null;
}

/** Asks for a fresh unread count whenever `version` changes (e.g. after marking notifications read). */
export function PollNow({ version }: { version: number }) {
  useEffect(() => {
    window.dispatchEvent(new Event(POLL_EVENT));
  }, [version]);
  return null;
}

/** Shows a notification from this browser right away (the "Send test" button for the browser channel). */
export async function testBrowserNotification(): Promise<{ ok: boolean; message: string }> {
  if (!('Notification' in window)) return { ok: false, message: 'This browser does not support notifications.' };
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return { ok: false, message: 'Browser notifications are blocked. Allow them for this site in your browser settings.' };
  new Notification('Test notification', { body: 'Notifications from Job Scraper reach you here.' });
  return { ok: true, message: 'Test shown by this browser.' };
}

export function EnableBrowserNotifications() {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        className="rounded-md border px-3 py-1.5"
        onClick={() => {
          if (!('Notification' in window)) return setMessage('This browser does not support notifications.');
          void Notification.requestPermission().then((p) => setMessage(p === 'granted' ? 'Browser notifications are on.' : 'Browser notifications are blocked in this browser.'));
        }}
      >
        Allow browser notifications
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
