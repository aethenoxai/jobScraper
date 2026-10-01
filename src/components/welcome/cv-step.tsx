'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { acceptCvStep, removeCvStep, retryCvStep, uploadCvStep } from '@/app/welcome/actions';
import { AutoRefresh } from '@/components/auto-refresh';
import { btn, btnPrimary, Card } from '@/components/ui';
import { CV_ACCEPT } from '@/lib/format';

export interface CvInfo {
  name: string;
  sizeBytes: number;
  status: string;
  error: string | null;
  uploadedAt: number;
}

const MAX_BYTES = 10 * 1024 * 1024;
const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** Refused in the browser at once: the server checks the content again. */
function problemWith(file: File): string | null {
  if (!/\.(pdf|docx|doc)$/i.test(file.name)) return `${file.name} isn’t a PDF or Word file. Choose a .pdf, .docx or .doc.`;
  if (file.size > MAX_BYTES) return `${file.name} is ${size(file.size)}; the limit is 10 MB.`;
  return null;
}

/** What the reading animation says, by how long it has been going. */
const STAGES = ['Sending your CV to', 'Reading your experience', 'Picking out skills and education', 'Checking every fact against your CV'];

function Reading({ name, model, since }: { name: string; model: string | null; since: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [since]);
  const stage = STAGES[Math.min(STAGES.length - 1, Math.floor(seconds / 6))];
  return (
    <div className="space-y-2" role="status" aria-live="polite" data-testid="cv-reading">
      <p className="flex items-center gap-2 text-sm">
        <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100" />
        {stage === STAGES[0] ? `${stage} ${model ?? 'the AI'}…` : `${stage}…`}
      </p>
      <div aria-hidden className="h-1.5 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
        <div className="h-full w-1/3 animate-[cv-progress_1.4s_ease-in-out_infinite] rounded bg-neutral-900 dark:bg-neutral-100" />
      </div>
      <p className="text-xs text-neutral-500">Reading {name} · {seconds} s. Nothing is invented: what can’t be read stays empty for you to fill in.</p>
    </div>
  );
}

/** Step 2: drop or choose the CV; it is uploaded at once and read by the AI model chosen in step 1. */
export function CvStep({ cv, model, found }: { cv: CvInfo | null; model: string | null; found: string | null }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reading = cv && (cv.status === 'uploaded' || cv.status === 'extracting');

  const send = (file: File | undefined) => {
    if (!file) return;
    const problem = problemWith(file);
    setMessage(problem);
    if (problem) return;
    setSending(file);
    const form = new FormData();
    form.set('cv', file);
    start(async () => {
      const r = await uploadCvStep(null, form); // moves on by itself when it works
      if (r && !r.ok) setMessage(r.message);
      setSending(null);
    });
  };
  const act = (fn: () => Promise<unknown>) => start(async () => void (await fn()));

  const chooser = (
    <input
      ref={picker}
      type="file"
      accept={CV_ACCEPT}
      className="sr-only"
      aria-label="Your CV (PDF or Word)"
      onChange={(e) => {
        send(e.target.files?.[0]);
        e.target.value = ''; // choosing the same file again still triggers
      }}
    />
  );

  return (
    <Card title="2. Your CV">
      <style>{`@keyframes cv-progress { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }`}</style>
      {reading && <AutoRefresh everyMs={2000} />}
      {!cv && !sending ? (
        <label
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-sm focus-within:ring-2 focus-within:ring-neutral-400 ${dragging ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-900' : 'border-neutral-300 dark:border-neutral-700'}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            send(e.dataTransfer.files[0]);
          }}
          data-testid="cv-drop"
        >
          {chooser}
          <span className="text-base font-medium">Drop your CV here or <span className="underline">choose a file</span></span>
          <span className="text-xs text-neutral-500">PDF or Word (.docx, .doc) · up to 10 MB · read by {model ?? 'your AI model'}</span>
        </label>
      ) : (
        <div className="space-y-4">
          {chooser}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid="cv-file">
            <p className="text-sm">
              <span aria-hidden>📄 </span>
              <b>{sending?.name ?? cv?.name}</b> <span className="text-neutral-500">· {size(sending?.size ?? cv?.sizeBytes ?? 0)}</span>
            </p>
            {!sending && (
              <span className="flex gap-2">
                <button type="button" className={btn} disabled={pending} onClick={() => picker.current?.click()}>Replace</button>
                <button type="button" className={btn} disabled={pending} onClick={() => act(removeCvStep)}>Remove</button>
              </span>
            )}
          </div>
          {sending ? (
            <p className="flex items-center gap-2 text-sm" role="status">
              <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100" />
              Uploading…
            </p>
          ) : reading ? (
            <Reading name={cv!.name} model={model} since={cv!.uploadedAt} />
          ) : cv?.status === 'failed' ? (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-red-600">Couldn’t be read. {cv.error}</p>
              <button type="button" className={btn} disabled={pending} onClick={() => act(retryCvStep)}>Try again</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-green-700 dark:text-green-400" data-testid="cv-read">✓ Read{found ? `: ${found}` : ''}.</p>
              <button type="button" className={btnPrimary} disabled={pending} onClick={() => act(acceptCvStep)}>Continue</button>
            </div>
          )}
        </div>
      )}
      {message && <p role="alert" className="mt-3 text-sm text-red-600">{message}</p>}
      <p className="mt-4 text-xs text-neutral-500"><Link href="/welcome?step=ai" className="underline">← Back to the AI model</Link></p>
    </Card>
  );
}
