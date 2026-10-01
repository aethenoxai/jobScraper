'use server';

import { revalidatePath } from 'next/cache';
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, mergeAiSettings, type AiSettings } from '@/server/ai';
import { disconnectChatGpt } from '@/server/ai/chatgpt-auth';
import { testAiSettings } from '@/server/ai/connect';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';

export interface AiActionResult {
  ok: boolean;
  message: string;
}

export async function saveAiSettings(_prev: AiActionResult | null, formData: FormData): Promise<AiActionResult> {
  const { settings } = getAppContext();
  const current = settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);
  const form = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  try {
    settings.set(AI_SETTINGS_KEY, mergeAiSettings(current, form));
  } catch {
    return { ok: false, message: 'Please check the form: a value is invalid (e.g. the base URL or budget).' };
  }
  revalidatePath('/settings/ai');
  return { ok: true, message: 'AI settings saved.' };
}

/** Tests the settings as they are in the form (saved or not), so the user can check before saving. */
export async function testAiConnection(formData: FormData): Promise<AiActionResult> {
  const { db, settings, log } = getAppContext();
  const current = settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);
  const form = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
  let candidate: AiSettings;
  try {
    candidate = mergeAiSettings(current, form);
  } catch {
    return { ok: false, message: 'Please check the form: a value is invalid (e.g. the base URL or budget).' };
  }
  return testAiSettings({ db, settings, log, env: () => liveEnv() }, candidate);
}

export async function disconnectChatGptAction(): Promise<void> {
  disconnectChatGpt(getAppContext().settings);
  revalidatePath('/settings/ai');
}
