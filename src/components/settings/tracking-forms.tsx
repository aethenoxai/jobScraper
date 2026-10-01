'use client';

import { useActionState } from 'react';
import { checkInboxNowAction, saveTrackingSettingsAction } from '@/app/(app)/settings/tracking/actions';
import { btn, btnPrimary, input } from '@/components/ui';

export function TrackingSettingsForm({ inboxEnabled, autoUpdate, threshold, ready }: { inboxEnabled: boolean; autoUpdate: boolean; threshold: number; ready: boolean }) {
  const [state, action, pending] = useActionState(saveTrackingSettingsAction, null);
  const [check, checkAction, checking] = useActionState(checkInboxNowAction, null);
  return (
    <div className="space-y-4 text-sm">
      <form action={action} className="space-y-3">
        <label className="flex items-center gap-2"><input type="checkbox" name="inboxEnabled" defaultChecked={inboxEnabled} /> Read my inbox for replies to my applications</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="autoUpdate" defaultChecked={autoUpdate} /> Move an application to “Interview” automatically when an AI model is confident an email from the employer invites you (offers, rejections and everything else always wait for you to confirm)</label>
        <label className="flex max-w-xs flex-col gap-1">Confidence needed for automatic updates (%)<input type="number" name="threshold" min={50} max={100} step="any" defaultValue={Math.round(threshold * 100)} className={input} /></label>
        <div className="flex items-center gap-3">
          <button className={btnPrimary} disabled={pending}>Save</button>
          {state && <span role="status" className={state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{state.message}</span>}
        </div>
      </form>
      <form action={checkAction} className="flex items-center gap-3">
        <button className={btn} disabled={checking || !ready || !inboxEnabled} title={!ready ? 'Set up a mailbox first (see above)' : !inboxEnabled ? 'Turn on inbox tracking first' : undefined}>Check now</button>
        {check && <span role="status" className={check.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{check.message}</span>}
      </form>
    </div>
  );
}
