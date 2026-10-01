import type { Metadata } from 'next';
import { SignInForm } from './signin-form';

export const metadata: Metadata = { title: 'Sign in' };

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: PageProps<'/signin'>) {
  const { next } = (await searchParams) as { next?: string };
  return (
    <main id="main" className="mx-auto max-w-sm space-y-4 p-4 pt-16">
      <h1 className="text-xl font-semibold">Sign in to Job Scraper</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">This Job Scraper is protected with a password (APP_PASSWORD in its .env file).</p>
      <SignInForm next={next ?? '/'} />
    </main>
  );
}
