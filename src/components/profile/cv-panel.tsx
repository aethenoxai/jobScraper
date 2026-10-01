'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import { uploadCv } from '@/app/profiles/actions';
import { btnPrimary } from '@/components/ui';

/** Upload form; while a CV is being extracted it refreshes the page so the result appears by itself. */
export function CvUploadForm({ profileId, busy }: { profileId: number; busy: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(uploadCv.bind(null, profileId), null);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [busy, router]);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <label htmlFor="cv-file" className="sr-only">CV file</label>
      <input id="cv-file" name="cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="text-sm" />
      <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Uploading…' : 'Upload CV'}</button>
      {state && <span role="status" className={`text-sm ${state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{state.message}</span>}
    </form>
  );
}
