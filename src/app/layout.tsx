import type { Metadata } from 'next';
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
        {children}
      </body>
    </html>
  );
}
