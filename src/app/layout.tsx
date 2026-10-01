import type { Metadata } from 'next';
import { AppNav } from '@/components/app-nav';
import { BrowserNotifier } from '@/components/notifications/browser-notifier';
import './globals.css';

export const metadata: Metadata = {
  title: { template: '%s · Job Scraper', default: 'Job Scraper' },
  description: 'Your local job-search agent',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow dark:focus:bg-neutral-900">
          Skip to content
        </a>
        <div className="flex min-h-screen flex-col md:flex-row">
          <aside className="w-full shrink-0 border-b border-neutral-200 md:w-56 md:border-r md:border-b-0 dark:border-neutral-800">
            <AppNav />
          </aside>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-8">{children}</main>
          <BrowserNotifier />
        </div>
      </body>
    </html>
  );
}
