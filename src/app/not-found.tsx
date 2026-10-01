import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main id="main" className="max-w-3xl space-y-4 p-4 md:p-8">
      <PageHeader title="Page not found" subtitle="It may have been deleted (an application, a profile) or the link is out of date." />
      <p className="text-sm">
        <Link href="/" className="underline">Go to the dashboard</Link> · <Link href="/feed" className="underline">Job feed</Link> · <Link href="/applications" className="underline">Applications</Link>
      </p>
    </main>
  );
}
