'use client';

import { useState, useTransition } from 'react';
import { sendTestEmailAction, type EmailActionResult } from '@/app/(app)/settings/email/actions';
import { btn } from '@/components/ui';

export function EmailTestButton() {
  const [result, setResult] = useState<EmailActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={btn} disabled={pending} onClick={() => start(async () => setResult(await sendTestEmailAction()))}>
        {pending ? 'Sending…' : 'Send a test email to yourself'}
      </button>
      {result && <span role="status" className={`text-sm ${result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{result.message}</span>}
    </div>
  );
}
