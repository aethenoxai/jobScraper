'use client';

import { useState, useTransition } from 'react';
import { saveCoverLetterAction, type ActionResult } from '@/app/(app)/applications/actions';
import { btn, btnPrimary, input } from '@/components/ui';
import type { CoverLetter } from '@/server/tailoring/cover-letter';

/** Edits the cover letter; the server accepts it only if it uses facts from the profile. */
export function CoverLetterEditor({ applicationId, initial }: { applicationId: number; initial: CoverLetter }) {
  const [greeting, setGreeting] = useState(initial.greeting);
  const [body, setBody] = useState(initial.paragraphs.join('\n\n'));
  const [closing, setClosing] = useState(initial.closing);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [saving, start] = useTransition();
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        start(async () => setResult(await saveCoverLetterAction(applicationId, { greeting, paragraphs, closing, method: 'edited' })));
      }}
    >
      <label className="flex flex-col gap-1">Greeting<input className={input} value={greeting} onChange={(e) => setGreeting(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Letter (blank line between paragraphs)<textarea className={`${input} min-h-56`} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Closing<input className={input} value={closing} onChange={(e) => setClosing(e.target.value)} /></label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save letter'}</button>
        <button type="button" className={btn} onClick={() => (setGreeting(initial.greeting), setBody(initial.paragraphs.join('\n\n')), setClosing(initial.closing), setResult(null))}>Undo changes</button>
        {result && <span role="status" className={result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{result.message}</span>}
      </div>
      {result && result.problems.length > 0 && <ul className="list-disc pl-5 text-red-600" aria-label="Letter problems">{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    </form>
  );
}
