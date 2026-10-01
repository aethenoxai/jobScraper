'use client';

import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/** On narrow screens the sidebar links fold behind a "Menu" button; it closes again on every page change. */
export function NavMenu({ children }: { children: ReactNode }) {
  return <Menu key={usePathname()}>{children}</Menu>;
}

function Menu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen((o) => !o)} className="rounded px-2 py-1 text-left font-medium hover:bg-neutral-100 md:hidden dark:hover:bg-neutral-800">
        {open ? 'Close menu' : 'Menu'}
      </button>
      <div id="main-menu" className={`${open ? 'flex' : 'hidden'} mt-2 flex-col gap-1 md:mt-0 md:flex`}>
        {children}
      </div>
    </>
  );
}
