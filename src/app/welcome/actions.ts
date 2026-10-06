'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { disconnectChatGpt } from '@/server/ai/chatgpt-auth';
import { claudeCodeSignOut } from '@/server/ai/claude-code';
import { registerSecret, scrubSecrets } from '@/server/logging';
import { AI_PROVIDERS, AI_TASKS, KEY_ENV_VAR, TASK_LABELS } from '@/server/ai/settings';
import { testProvider } from '@/server/ai/connect';
import { applyProviderForm, applyTaskForm, updateAiSettings } from '@/server/ai/provider-view';
import { updateOnboarding } from '@/server/onboarding';
import { liveEnv, shellDefines, writeEnvValue } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { isNamedError } from '@/lib/format';
import { acceptCv, beginCvUpload, confirmProfile, removeCv, retryCv, saveJobPreferences, startJobSearch, type JobPreferencesInput, type SavePreferencesResult } from '@/server/onboarding-steps';

export interface StepResult {
  ok: boolean;
  message: string;
}

/**
 * Step 1: save what each task uses, then test the provider that reads the CV (one tiny call, at most 20 s: the user
 * waits). Every task naming a provider must be ready; a task set to "None" runs offline on purpose. Keys are never
 * typed here: they live in .env.
 */
export async function saveAiStep(_prev: StepResult | null, form: FormData): Promise<StepResult> {
  const { db, settings, log, ai } = getAppContext();
  const inDocker = process.env.JOB_SCRAPER_IN_DOCKER === 'true';
  // A pasted key goes to .env first (guarded, atomic, 0600); the checks below read it live.
  for (const p of AI_PROVIDERS) {
    const keyVar = KEY_ENV_VAR[p];
    const key = String(form.get(`apiKey.${p}`) ?? '').trim();
    if (!keyVar || !key) continue;
    registerSecret(key);
    if (inDocker) return { ok: false, message: `In Docker, add ${keyVar}=<your key> to the .env file next to docker-compose.yml, run "docker compose up -d", then continue.` };
    if (shellDefines(keyVar)) return { ok: false, message: `${keyVar} is set in the shell that started Job Scraper, and that value wins over .env. Leave the field empty, or remove it from the shell and restart.` };
    try {
      writeEnvValue(keyVar, key);
    } catch (err) {
      return { ok: false, message: `Could not save the key to .env: ${scrubSecrets(err instanceof Error ? err.message : String(err))}` };
    }
  }
  const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  try {
    updateAiSettings(settings, liveEnv(), (c) => applyProviderForm(applyTaskForm(c, fields), fields));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Please check the form.' };
  }
  const way = ' To go on anyway, set “Reading your CV” to None: your CV is then read on this computer, without AI.';
  const stuck = AI_TASKS.map((t) => ai.taskStatus(t)).filter((s) => s.provider !== 'none' && !s.configured);
  if (stuck.length) return { ok: false, message: stuck.map((s) => `${TASK_LABELS[s.task].title}: ${s.reason}`).join(' ') + way };
  const reading = ai.taskStatus('cv-extract');
  if (reading.provider !== 'none') {
    const tested = await testProvider(
      { db, settings, log, env: () => liveEnv(), writeKey: (k, v) => void writeEnvValue(k, v), shellDefines: (k) => shellDefines(k), inDocker },
      { provider: reading.provider, model: reading.model ?? '' },
    );
    if (!tested.ok) return { ok: false, message: tested.message + way };
  }
  updateOnboarding(settings, (s) => ({ ...s, aiVerifiedAt: Date.now() }));
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
