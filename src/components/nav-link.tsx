'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A sidebar link that marks the page you are on (for screen readers too). */
export function NavLink({ href, children, className = '', testId }: { href: string; children: ReactNode; className?: string; testId?: string }) {
  const pathname = usePathname();
  const current = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={current ? 'page' : undefined} data-testid={testId} className={`rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${current ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''} ${className}`}>
      {children}
    </Link>
  );
}
