'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { btn } from '@/components/ui';

export interface ClaudeCodeInfo {
  installed: boolean;
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  message: string;
}

const SIGN_OUT_WARNING =
  'Sign Claude Code out on this computer?\n\nThis is your own Claude Code: it is also signed out in your terminal and editor. To use Claude here again, run `claude auth login` in a terminal and sign in with the account you want.';

/** Which Claude account Job Scraper uses (the one signed in to Claude Code), with a way to sign out or check again. */
export function ClaudeCodeAccount({ status, signOut }: { status: ClaudeCodeInfo; signOut: () => Promise<void> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!status.loggedIn) {
    return (
      <div className="space-y-2" data-testid="claude-code-account">
        <p>{status.message}</p>
        {status.installed && (
          <button type="button" className={btn} onClick={() => router.refresh()}>Check again</button>
        )}
      </div>
    );
  }
  const plan = status.plan ? `${status.plan[0].toUpperCase()}${status.plan.slice(1)} plan` : null;
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="claude-code-account">
      <p className="text-green-700 dark:text-green-400">
        Signed in{status.email ? <> as <b>{status.email}</b></> : ''}{plan ? ` · ${plan}` : ''}
      </p>
      <button
        type="button"
        className={btn}
        disabled={pending}
        onClick={() => {
          if (!window.confirm(SIGN_OUT_WARNING)) return;
          start(async () => {
            await signOut();
            router.refresh();
          });
        }}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
