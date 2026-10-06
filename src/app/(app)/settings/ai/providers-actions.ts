'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AI_PROVIDERS, AI_SETTINGS_KEY, migrateAiSettings, type AiProvider } from '@/server/ai';
import { disconnectChatGpt } from '@/server/ai/chatgpt-auth';
import { claudeCodeSignOut } from '@/server/ai/claude-code';
import { testProvider } from '@/server/ai/connect';
import { applyProviderForm, applyTaskForm, testBaseUrl, testModelFor } from '@/server/ai/provider-view';
import { liveEnv, shellDefines, writeEnvValue } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';

export interface ProviderActionResult {
  ok: boolean;
  message: string;
}

const readSettings = () => migrateAiSettings(getAppContext().settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), liveEnv());

/** Saves the per-provider addresses and daily limits. Keys are never handled here: they live only in .env. */
export async function saveProviders(_prev: ProviderActionResult | null, form: FormData): Promise<ProviderActionResult> {
  const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  try {
    getAppContext().settings.set(AI_SETTINGS_KEY, applyProviderForm(readSettings(), fields));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Please check the form.' };
  }
  revalidatePath('/settings/ai');
  return { ok: true, message: 'Providers saved.' };
}

/** Saves which provider and model each task uses. Everything else in the settings stays as it is. */
export async function saveTasks(_prev: ProviderActionResult | null, form: FormData): Promise<ProviderActionResult> {
  const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  try {
    getAppContext().settings.set(AI_SETTINGS_KEY, applyTaskForm(readSettings(), fields));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Please check the form.' };
  }
  revalidatePath('/settings/ai');
  return { ok: true, message: 'Task settings saved.' };
}

/** One tiny call to the provider with the key already in .env. Routing is never changed. */
export async function testProviderConnection(provider: string, baseUrl: string): Promise<ProviderActionResult> {
  if (!(AI_PROVIDERS as readonly string[]).includes(provider) || provider === 'none') return { ok: false, message: 'Unknown provider.' };
  const { db, settings, log, ai } = getAppContext();
  // Keys live only in .env: say so instead of asking for one to be pasted.
  const status = ai.providerStatus(provider as AiProvider);
  if (status.keyEnvVar && provider !== 'openai-compatible' && !status.keyPresent) return { ok: false, message: status.reason ?? `Add ${status.keyEnvVar} to your .env file.` };
  return testProvider(
    { db, settings, log, env: () => liveEnv(), writeKey: (k, v) => void writeEnvValue(k, v), shellDefines: (k) => shellDefines(k), inDocker: process.env.JOB_SCRAPER_IN_DOCKER === 'true' },
    { provider, model: testModelFor(provider as Exclude<AiProvider, 'none'>, readSettings()), baseUrl: testBaseUrl(provider as AiProvider, baseUrl) },
  );
}

export async function disconnectChatGptProvider(): Promise<void> {
  disconnectChatGpt(getAppContext().settings);
  revalidatePath('/settings/ai');
}

export async function signOutClaudeCodeProvider(): Promise<void> {
  await claudeCodeSignOut();
  revalidatePath('/settings/ai');
}
