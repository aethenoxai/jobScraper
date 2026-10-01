/**
 * The first setup step: choose an AI provider and models, save a pasted key to .env, and prove it works with one tiny
 * call before going on (PRD §37: keys live only in .env).
 */
import { z } from 'zod';
import type { Db } from '../db';
import { registerSecret, scrubSecrets, type Logger } from '../logging';
import { updateOnboarding } from '../onboarding';
import type { SettingsStore } from '../settings';
import { createAi, type ModelFactory } from './index';
import { AI_PROVIDERS, AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, KEY_ENV_VAR, mergeAiSettings, PROVIDER_LABELS, type AiProvider, type AiSettings } from './settings';

export interface ConnectDeps {
  db: Db;
  settings: SettingsStore;
  log: Logger;
  env: () => Record<string, string | undefined>;
  /** Saves a key to the env file (the env returned by `env` then has it). */
  writeKey: (key: string, value: string) => void;
  /** True when the variable was set in the shell that started Job Scraper (that value wins over .env). */
  shellDefines?: (key: string) => boolean;
  /** In Docker the container's settings come from the .env file on the computer: keys can't be saved from inside. */
  inDocker: boolean;
  modelFactory?: ModelFactory;
  now?: () => Date;
}

export interface ConnectForm {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  fastModel?: string;
  qualityModel?: string;
}

export interface ConnectResult {
  ok: boolean;
  message: string;
}

/** Tries the given settings with one small structured call. */
export async function testAiSettings(deps: Pick<ConnectDeps, 'db' | 'settings' | 'log' | 'env' | 'modelFactory'>, candidate: AiSettings): Promise<ConnectResult> {
  const overlay: SettingsStore = { ...deps.settings, get: (key, schema, fallback) => (key === AI_SETTINGS_KEY ? (candidate as never) : deps.settings.get(key, schema, fallback)) };
  const ai = createAi({ db: deps.db, settings: overlay, log: deps.log, env: deps.env, modelFactory: deps.modelFactory });
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
    return out.ok ? { ok: true, message: `Connected to ${PROVIDER_LABELS[status.provider]} (${status.models.fast}).` } : { ok: false, message: 'The model answered, but not as expected.' };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  }
}

export async function connectAi(deps: ConnectDeps, form: ConnectForm): Promise<ConnectResult> {
  const provider = form.provider as AiProvider;
  if (!(AI_PROVIDERS as readonly string[]).includes(provider) || provider === 'none') return { ok: false, message: 'Choose an AI provider.' };
  const label = PROVIDER_LABELS[provider];
  const keyVar = KEY_ENV_VAR[provider];
  const key = form.apiKey?.trim() ?? '';
  // Whatever happens next, a pasted key never appears in a message or a log line.
  registerSecret(key);
  if (keyVar && key) {
    if (deps.inDocker) return { ok: false, message: `In Docker, add ${keyVar}=<your key> to the .env file next to docker-compose.yml, run "docker compose up -d", then test again with this field left empty.` };
    if (deps.shellDefines?.(keyVar)) return { ok: false, message: `${keyVar} is set in the shell that started Job Scraper, and that value wins over .env. Leave this field empty to test with it, or remove it from the shell and restart.` };
    try {
      deps.writeKey(keyVar, key);
    } catch (err) {
      return { ok: false, message: `Could not save the key to .env: ${scrubSecrets(err instanceof Error ? err.message : String(err))}` };
    }
  } else if (keyVar && provider !== 'openai-compatible' && !deps.env()[keyVar]) {
    return { ok: false, message: `Paste your ${label} API key.` };
  }

  const current = deps.settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);
  let candidate: AiSettings;
  try {
    candidate = mergeAiSettings(current, { provider, fastModel: form.fastModel ?? '', qualityModel: form.qualityModel ?? '', baseUrl: form.baseUrl ?? '' });
  } catch {
    return { ok: false, message: 'Please check the form: the server address must be a full URL such as http://127.0.0.1:11434/api.' };
  }
  const result = await testAiSettings(deps, candidate);
  if (!result.ok) return result;
  deps.settings.set(AI_SETTINGS_KEY, candidate);
  const now = (deps.now ?? (() => new Date()))().getTime();
  updateOnboarding(deps.settings, (s) => ({ ...s, aiVerifiedAt: now }));
  return result;
}
