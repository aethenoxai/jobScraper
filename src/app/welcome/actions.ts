'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { disconnectChatGpt } from '@/server/ai/chatgpt-auth';
import { claudeCodeSignOut } from '@/server/ai/claude-code';
import { saveAiChoices } from '@/server/ai/wizard-save';
import { liveEnv, shellDefines, writeEnvValue } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { isNamedError } from '@/lib/format';
import { acceptCv, beginCvUpload, confirmProfile, removeCv, retryCv, saveJobPreferences, startJobSearch, type JobPreferencesInput, type SavePreferencesResult } from '@/server/onboarding-steps';

export interface StepResult {
  ok: boolean;
  message: string;
}

/** Step 1: save what each task uses and test the CV-reading provider (≤20 s: the user waits). See `saveAiChoices`. */
export async function saveAiStep(_prev: StepResult | null, form: FormData): Promise<StepResult> {
  const { db, settings, log, ai } = getAppContext();
  const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  const done = await saveAiChoices(
    { db, settings, log, ai, env: () => liveEnv(), writeKey: (k, v) => void writeEnvValue(k, v), shellDefines: (k) => shellDefines(k), inDocker: process.env.JOB_SCRAPER_IN_DOCKER === 'true' },
    fields,
  );
  if (!done.ok) return done;
  revalidatePath('/welcome');
  redirect('/welcome');
}

/** Step 1: forget the ChatGPT sign-in. */
export async function disconnectChatGptStep(): Promise<void> {
  disconnectChatGpt(getAppContext().settings);
  revalidatePath('/welcome');
}

/** Step 1: sign the user's Claude Code out (they confirmed it signs out everywhere on this computer). */
export async function signOutClaudeCodeStep(): Promise<void> {
  await claudeCodeSignOut();
  revalidatePath('/welcome');
}

/** Step 2: store the CV; the worker reads it with the chosen model. */
export async function uploadCvStep(_prev: StepResult | null, form: FormData): Promise<StepResult> {
  const file = form.get('cv');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose your CV (PDF or Word .docx) first.' };
  try {
    await beginCvUpload(getAppContext(), { name: file.name, buf: Buffer.from(await file.arrayBuffer()) });
  } catch (err) {
    if (isNamedError(err, 'UnsupportedCvTypeError', 'CvTooLargeError')) return { ok: false, message: err.message };
    getAppContext().log.error({ err }, 'CV upload during setup failed');
    return { ok: false, message: 'The CV could not be stored. Check the logs for details.' };
  }
  revalidatePath('/welcome');
  redirect('/welcome');
}

/** Step 2: Continue once the CV is read. */
export async function acceptCvStep(): Promise<void> {
  acceptCv(getAppContext());
  revalidatePath('/welcome');
  redirect('/welcome');
}

/** Step 2: Remove the CV (and the draft profile made from it). */
export async function removeCvStep(): Promise<void> {
  await removeCv(getAppContext());
  revalidatePath('/welcome');
}

/** Step 2: Try again after a CV couldn't be read. */
export async function retryCvStep(): Promise<void> {
  retryCv(getAppContext());
  revalidatePath('/welcome');
}

/** Step 3: the profile is right (the editor saved it just before). */
export async function confirmProfileStep(): Promise<void> {
  confirmProfile(getAppContext());
  revalidatePath('/welcome');
  redirect('/welcome');
}

/** Step 4: where and what. */
export async function saveJobPreferencesStep(input: JobPreferencesInput): Promise<SavePreferencesResult> {
  const result = saveJobPreferences(getAppContext(), input);
  if (!result.ok) return result;
  revalidatePath('/welcome');
  redirect('/welcome');
}

/** Step 5: start the job search and open the dashboard. */
export async function startJobSearchStep(intervalMinutes: number): Promise<StepResult> {
  try {
    startJobSearch(getAppContext(), intervalMinutes);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/', 'layout');
  redirect('/');
}
