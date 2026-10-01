'use client';

import { useActionState } from 'react';
import { renameProfile } from '@/app/profiles/actions';
import { btn, input } from '@/components/ui';

export function RenameForm({ profileId, name }: { profileId: number; name: string }) {
  const [state, action, pending] = useActionState(renameProfile.bind(null, profileId), null);
  return (
    <form action={action} className="flex items-center gap-2">
      <label htmlFor="profile-name" className="sr-only">Profile name</label>
      <input id="profile-name" name="name" defaultValue={name} className={`${input} w-64`} />
      <button className={btn} disabled={pending}>Rename</button>
      {state && !state.ok && <span className="text-sm text-red-600">{state.message}</span>}
    </form>
  );
}
