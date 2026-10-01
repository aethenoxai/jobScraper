'use client';

import { useState, useTransition } from 'react';
import { sendEmailAction, type ActionResult } from '@/app/(app)/applications/actions';
import { btnPrimary, input } from '@/components/ui';
import type { EmailDraft } from '@/server/applications/email-draft';

/** Review, edit and send the application email. Nothing is sent until the user presses Send. */
export function EmailComposer({ applicationId, initial, canSend, updating, sender, hasCoverLetterPdf }: { applicationId: number; initial: EmailDraft; canSend: boolean; updating?: boolean; sender: { ok: boolean; text: string }; hasCoverLetterPdf: boolean }) {
  const [draft, setDraft] = useState(initial);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [sending, start] = useTransition();
  const set = (patch: Partial<EmailDraft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!window.confirm(`Send this application to ${draft.to} from ${sender.text}?`)) return;
        start(async () => setResult(await sendEmailAction(applicationId, draft)));
      }}
    >
      <p className={sender.ok ? 'text-neutral-600 dark:text-neutral-400' : 'text-amber-700 dark:text-amber-400'}>{sender.ok ? `From: ${sender.text}` : sender.text}</p>
      <label className="flex flex-col gap-1">To<input className={input} value={draft.to} onChange={(e) => set({ to: e.target.value })} /></label>
      <label className="flex flex-col gap-1">Subject<input className={input} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} /></label>
      <label className="flex flex-col gap-1">Message<textarea className={`${input} min-h-64 font-mono text-xs`} value={draft.body} onChange={(e) => set({ body: e.target.value })} /></label>
      <p className="text-neutral-500">Attached: your tailored CV (PDF){draft.attachCoverLetter ? ' and the cover letter (PDF)' : ''}.</p>
      {hasCoverLetterPdf && (
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.attachCoverLetter} onChange={(e) => set({ attachCoverLetter: e.target.checked })} /> Also attach the cover letter as a PDF</label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={sending || !canSend || !sender.ok}>{sending ? 'Sending…' : 'Send application'}</button>
        {updating && <span className="text-neutral-500">Updating the PDF with your changes…</span>}
        {result && <span role="status" className={result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{result.message}</span>}
      </div>
      {result && result.problems.length > 0 && <ul className="list-disc pl-5 text-red-600">{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    </form>
  );
}
