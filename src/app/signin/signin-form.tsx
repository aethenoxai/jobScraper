'use client';

import { useActionState } from 'react';
import { btnPrimary, input } from '@/components/ui';
import { signInAction } from './actions';

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">Password<input type="password" name="password" autoComplete="current-password" required autoFocus className={input} /></label>
      <button className={btnPrimary} disabled={pending}>Sign in</button>
      {state?.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
