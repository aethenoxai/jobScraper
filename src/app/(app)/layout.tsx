import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { BrowserNotifier } from '@/components/notifications/browser-notifier';
import { getAppContext } from '@/server/context';
import { isOnboarded } from '@/server/onboarding';

export const dynamic = 'force-dynamic';

/** Every app page: the menu, and nothing at all until onboarding is finished (it opens at /welcome instead). */
export default function AppLayout({ children }: LayoutProps<'/'>) {
  if (!isOnboarded(getAppContext())) redirect('/welcome');
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="w-full shrink-0 border-b border-neutral-200 md:w-56 md:border-r md:border-b-0 dark:border-neutral-800">
        <AppNav />
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-8">{children}</main>
      <BrowserNotifier />
    </div>
  );
}
