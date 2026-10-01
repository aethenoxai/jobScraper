'use client';

import './globals.css';

/** Last-resort error page when the root layout itself fails (it replaces the whole document). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen p-8 antialiased">
        <div className="max-w-xl space-y-3">
          <h1 className="text-xl font-semibold">Job Scraper hit a problem</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{error.message || 'An unexpected error occurred.'}</p>
          <p className="text-sm">If this keeps happening, restart Job Scraper and check the terminal it runs in for details.</p>
          <button onClick={reset} className="rounded-md border px-3 py-1.5 text-sm">Try again</button>
        </div>
      </body>
    </html>
  );
}
