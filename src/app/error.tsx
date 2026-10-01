'use client';

import { ErrorPanel } from '@/components/error-panel';

/** Errors outside the app pages (setup, sign-in) or in the app layout itself. */
export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="p-4 md:p-8">
      <ErrorPanel {...props} />
    </main>
  );
}
