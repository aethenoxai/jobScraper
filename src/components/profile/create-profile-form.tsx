'use client';

import { useActionState } from 'react';
import { createProfile } from '@/app/(app)/profiles/actions';
import { btnPrimary, input } from '@/components/ui';
import { CV_ACCEPT } from '@/lib/format';

export function CreateProfileForm() {
  const [state, action, pending] = useActionState(createProfile, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="new-profile-name">Profile name</label>
        <input id="new-profile-name" name="name" placeholder="e.g. Software Engineer" className={input} />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="new-profile-cv">Latest CV (PDF or .docx, optional)</label>
        <input id="new-profile-cv" name="cv" type="file" accept={CV_ACCEPT} className="text-sm" />
      </div>
      <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Creating…' : 'Create profile'}</button>
      {state && !state.ok && <p role="alert" className="text-sm text-red-600 sm:col-span-3">{state.message}</p>}
    </form>
  );
}
