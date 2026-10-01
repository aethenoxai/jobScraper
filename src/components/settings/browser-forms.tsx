'use client';

import { useActionState } from 'react';
import { saveBrowserSettingsAction, signInToSiteAction } from '@/app/(app)/settings/browser/actions';
import { btn, btnPrimary, input } from '@/components/ui';

export function BrowserSettingsForm({ visible, dailyCap }: { visible: boolean; dailyCap: number }) {
  const [state, action, pending] = useActionState(saveBrowserSettingsAction, null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" name="visible" defaultChecked={visible} /> Show the browser while applying (recommended, so you can watch)</label>
      <label className="flex max-w-xs flex-col gap-1">Website applications per day (at most)<input type="number" name="dailyCap" min={1} max={200} step="any" defaultValue={dailyCap} className={input} /></label>
      <div className="flex items-center gap-3">
        <button className={btnPrimary} disabled={pending}>Save</button>
        {state && <span role="status" className={state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{state.message}</span>}
      </div>
    </form>
  );
}

export function SignInForm() {
  const [state, action, pending] = useActionState(signInToSiteAction, null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex flex-col gap-1">Site to sign in to<input name="url" type="url" placeholder="https://careers.example.com/login" className={input} /></label>
      <div className="flex items-center gap-3">
        <button className={btn} disabled={pending}>Open browser to sign in</button>
        {state && <span role="status" className={state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{state.message}</span>}
      </div>
    </form>
  );
}
