'use server';

import { revalidatePath } from 'next/cache';
import { isNamedError } from '@/lib/format';
import { ADD_URL_TASK, addJobManually, PASTE_HINT } from '@/server/discovery/add-url';
import { notAutomated } from '@/server/jobs/links';
import { getAppContext } from '@/server/context';
import { enqueueMatching } from '@/server/matching/tasks';

export interface JobActionResult {
  ok: boolean;
  message: string;
}

export async function addJobUrl(_prev: JobActionResult | null, formData: FormData): Promise<JobActionResult> {
  const url = String(formData.get('url') ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, message: 'Paste a full link starting with http:// or https://' };
  // Sites Job Scraper never reads (LinkedIn, Indeed…): say so now rather than after a background attempt.
  if (notAutomated(url)) return { ok: false, message: PASTE_HINT };
  getAppContext().queue.enqueue(ADD_URL_TASK, { url }, { dedupeKey: `${ADD_URL_TASK}:${url}`, maxAttempts: 2 });
  revalidatePath('/jobs');
  return { ok: true, message: 'Adding the job in the background…' };
}

export async function pasteJob(_prev: JobActionResult | null, formData: FormData): Promise<JobActionResult> {
  const { sources, ingestor, queue } = getAppContext();
  const field = (k: string) => String(formData.get(k) ?? '');
  try {
    const { jobIds } = addJobManually({ title: field('title'), company: field('company'), location: field('location'), url: field('url'), description: field('description') }, { sources, ingestor });
    enqueueMatching(queue, jobIds);
  } catch (err) {
    if (isNamedError(err, 'AddJobError')) return { ok: false, message: err.message };
    throw err;
  }
  revalidatePath('/jobs');
  return { ok: true, message: 'Job added.' };
}
