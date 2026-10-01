'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { uploadCvStep } from '@/app/welcome/actions';
import { AutoRefresh } from '@/components/auto-refresh';
import { btnPrimary, Card, Notice } from '@/components/ui';

interface CvInfo {
  name: string;
  status: string;
  error: string | null;
}

/** Step 2: upload the CV; the worker reads it with the chosen model while this page waits. */
export function CvStep({ cv, model, replacing }: { cv: CvInfo | null; model: string | null; replacing: boolean }) {
  const [state, action, pending] = useActionState(uploadCvStep, null);
  const reading = cv && (cv.status === 'uploaded' || cv.status === 'extracting');
  if (reading && !replacing) {
    return (
      <Card title="2. Reading your CV">
        <AutoRefresh everyMs={2000} />
        <p className="text-sm" data-testid="cv-reading">
          Reading <b>{cv.name}</b>{model ? ` with ${model}` : ''}… This usually takes less than a minute.
        </p>
        <p className="mt-2 text-xs text-neutral-500">Nothing is invented: what can’t be read stays empty for you to fill in.</p>
      </Card>
    );
  }
  return (
    <Card title="2. Upload your latest CV">
      {cv?.status === 'failed' && !replacing && (
        <div className="mb-4">
          <Notice tone="red">
            <b>{cv.name}</b> couldn’t be read. {cv.error ?? ''} Try another file.
          </Notice>
        </div>
      )}
      {replacing && <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">A different CV replaces the profile read from the current one. <Link href="/welcome" className="underline">Keep the current CV</Link></p>}
      <form action={action} className="space-y-3">
        <label className="flex flex-col gap-1 text-sm">
          Your CV (PDF or Word .docx, up to 10 MB)
          <input name="cv" type="file" required accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="text-sm" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Uploading…' : 'Upload and read'}</button>
          {state && !state.ok && <span role="status" className="text-sm text-red-600">{state.message}</span>}
        </div>
      </form>
      <p className="mt-4 text-xs text-neutral-500"><Link href="/welcome?step=ai" className="underline">← Back to the AI model</Link></p>
    </Card>
  );
}
