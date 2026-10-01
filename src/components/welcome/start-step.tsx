'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { startJobSearchStep } from '@/app/welcome/actions';
import { btnPrimary, input } from '@/components/ui';
import { describeInterval, INTERVAL_PRESETS } from '@/server/scheduler';

const REMOTE: Record<string, string> = { country: 'remote jobs open to your country', worldwide: 'remote jobs from anywhere', none: 'no remote jobs' };

/** Step 5: a summary in a dialog, and the button that starts the job search. Then the dashboard opens. */
export function StartStep({ titles, places, remote, salary, sources, interval }: { titles: string[]; places: string[]; remote: string; salary: string | null; sources: string[]; interval: number }) {
  const [minutes, setMinutes] = useState((INTERVAL_PRESETS as readonly number[]).includes(interval) ? interval : 60);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="start-title" className="w-full max-w-lg space-y-4 rounded-lg bg-[var(--background)] p-6 shadow-xl">
        <h2 id="start-title" className="text-xl font-semibold">Start your job search</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm" data-testid="start-summary">
          <dt className="text-neutral-500">Looking for</dt>
          <dd>{titles.join(', ')}</dd>
          <dt className="text-neutral-500">Where</dt>
          <dd>{places.join('; ') || 'anywhere'}, plus {REMOTE[remote] ?? 'remote jobs'}</dd>
          <dt className="text-neutral-500">Pay</dt>
          <dd>{salary ?? 'not set'}</dd>
          <dt className="text-neutral-500">Sources</dt>
          <dd>{sources.length ? sources.join(', ') : 'none yet: add some on the Job sources page'}</dd>
        </dl>
        <label className="flex flex-col gap-1 text-sm">
          Look for new jobs
          <select className={input} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {INTERVAL_PRESETS.map((m) => (
              <option key={m} value={m}>{describeInterval(m)}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-neutral-500">You’re told about each new match and decide yourself: nothing is ever sent without your approval.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimary}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await startJobSearchStep(minutes);
                if (r && !r.ok) setError(r.message);
              })
            }
          >
            {pending ? 'Starting…' : 'Start job search'}
          </button>
          <Link href="/welcome?step=preferences" className="text-xs underline">← Change what you’re looking for</Link>
        </div>
      </div>
    </div>
  );
}
