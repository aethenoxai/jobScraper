'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-xl space-y-3">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{error.message || 'An unexpected error occurred.'}</p>
      <button onClick={reset} className="rounded-md border px-3 py-1.5 text-sm">Try again</button>
    </div>
  );
}
