'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { disconnectChatGpt } from '@/server/ai/chatgpt-auth';
import { claudeCodeSignOut } from '@/server/ai/claude-code';
import { connectAi } from '@/server/ai/connect';
import { liveEnv, shellDefines, writeEnvValue } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { isNamedError } from '@/lib/format';
import { beginCvUpload, confirmProfile, saveJobPreferences, startJobSearch, type JobPreferencesInput, type SavePreferencesResult } from '@/server/onboarding-steps';

export interface StepResult {
  ok: boolean;
  message: string;
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v : undefined;
};

/** Step 1: save the key (to .env), test the chosen models, and move on when they answer. */
export async function connectAiStep(form: FormData): Promise<StepResult> {
  const { db, settings, log } = getAppContext();
  const result = await connectAi(
    {
      db,
      settings,
      log,
      env: () => liveEnv(),
      writeKey: (key, value) => {
        writeEnvValue(key, value);
      },
      shellDefines: (key) => shellDefines(key),
      inDocker: process.env.JOB_SCRAPER_IN_DOCKER === 'true',
    },
    { provider: text(form, 'provider') ?? '', apiKey: text(form, 'apiKey'), baseUrl: text(form, 'baseUrl'), fastModel: text(form, 'fastModel'), qualityModel: text(form, 'qualityModel') },
  );
  if (result.ok) revalidatePath('/welcome');
  return result;
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
