import Link from 'next/link';
import { NavLink } from './nav-link';
import { NavMenu } from './nav-menu';
import { InboxBadge } from './notifications/browser-notifier';

const SECTIONS = [
  { heading: null, links: [{ href: '/', label: 'Dashboard' }, { href: '/feed', label: 'Job feed' }, { href: '/applications', label: 'Applications' }, { href: '/jobs', label: 'All jobs' }, { href: '/profiles', label: 'Profiles' }, { href: '/system', label: 'System' }] },
  {
    heading: 'Settings',
    links: [
      { href: '/sources', label: 'Job sources' },
      { href: '/settings/notifications', label: 'Notifications' },
      { href: '/settings/email', label: 'Email' },
      { href: '/settings/browser', label: 'Browser' },
      { href: '/settings/tracking', label: 'Tracking' },
      { href: '/settings/scheduling', label: 'Scheduling' },
      { href: '/settings/ai', label: 'AI provider' },
    ],
  },
];

/** The sidebar; on narrow screens it folds into a "Menu" at the top of the page. */
export function AppNav() {
  const links = (
    <>
      <NavLink href="/notifications" className="mb-4" testId="inbox-link">
        Inbox <InboxBadge />
      </NavLink>
      {SECTIONS.map((section, i) => (
        <div key={i} className="mb-3 flex flex-col gap-1">
          {section.heading && <span className="px-2 text-xs font-semibold uppercase text-neutral-500">{section.heading}</span>}
          {section.links.map((l) => (
            <NavLink key={l.href} href={l.href}>
              {l.label}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-4 text-sm">
      <Link href="/" className="mb-2 text-lg font-semibold">Job Scraper</Link>
      <NavMenu>{links}</NavMenu>
    </nav>
  );
}
