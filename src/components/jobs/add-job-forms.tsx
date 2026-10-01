'use client';

import { useActionState } from 'react';
import { addJobUrl, pasteJob, type JobActionResult } from '@/app/(app)/jobs/actions';
import { btn, btnPrimary, input } from '@/components/ui';

function Result({ state }: { state: JobActionResult | null }) {
  if (!state) return null;
  return <span role="status" className={`text-sm ${state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{state.message}</span>;
}

export function AddJobUrlForm() {
  const [state, action, pending] = useActionState(addJobUrl, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label htmlFor="job-url" className="sr-only">Job link</label>
      <input id="job-url" name="url" type="url" required placeholder="https://company.com/careers/job-123" className={`${input} min-w-80 flex-1`} />
      <button className={btnPrimary} disabled={pending}>Add job</button>
      <Result state={state} />
    </form>
  );
}

export function PasteJobForm() {
  const [state, action, pending] = useActionState(pasteJob, null);
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">Job title<input name="title" required className={input} /></label>
      <label className="flex flex-col gap-1 text-sm">Company<input name="company" required className={input} /></label>
      <label className="flex flex-col gap-1 text-sm">Location<input name="location" className={input} /></label>
      <label className="flex flex-col gap-1 text-sm">Link (optional)<input name="url" type="url" className={input} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Job description<textarea name="description" required rows={6} className={input} /></label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={btn} disabled={pending}>Save job</button>
        <Result state={state} />
      </div>
    </form>
  );
}
