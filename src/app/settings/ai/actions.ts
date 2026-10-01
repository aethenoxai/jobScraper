'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AI_SETTINGS_KEY, AiSettingsSchema, createAi, DEFAULT_AI_SETTINGS, mergeAiSettings, type AiSettings } from '@/server/ai';
import type { SettingsStore } from '@/server/settings';
import { getAppContext } from '@/server/context';
import { scrubSecrets } from '@/server/logging';

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
  const overlay: SettingsStore = { ...settings, get: (key, schema, fallback) => (key === AI_SETTINGS_KEY ? (candidate as never) : settings.get(key, schema, fallback)) };
  const ai = createAi({ db, settings: overlay, log });
  const status = ai.status();
  if (!status.configured) return { ok: false, message: status.reason ?? 'AI is not configured.' };
  try {
    const out = await ai.generateObject({
      role: 'fast',
      task: 'connection-test',
      schema: z.object({ ok: z.boolean() }),
      system: 'You are a health check. Reply exactly as instructed.',
      prompt: 'Return {"ok": true}.',
      timeoutMs: 20_000,
    });
    return out.ok ? { ok: true, message: `Connected to ${status.provider} (${status.models.fast}).` } : { ok: false, message: 'The model answered, but not as expected.' };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  }
}
