/**
 * Tests one AI provider and model: saves a pasted key to .env and proves it works with one tiny call (PRD §37: keys live only in .env).
 */
import { z } from 'zod';
import type { Db } from '../db';
import { registerSecret, scrubSecrets, type Logger } from '../logging';
import type { SettingsStore } from '../settings';
import { createAi, type ModelFactory } from './index';
import { AI_PROVIDERS, AI_SETTINGS_KEY, KEY_ENV_VAR, migrateAiSettings, PROVIDER_LABELS, type AiProvider } from './settings';

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
}

export interface TestProviderRequest {
  provider: string;
  model: string;
  apiKey?: string;
  /** Overrides the saved server address for this test only (Ollama, OpenAI-compatible). */
  baseUrl?: string;
}

export interface ConnectResult {
  ok: boolean;
  message: string;
}

/**
 * Saves a pasted key to .env, then makes one small structured call to the given provider and model. Nothing but the
 * key is saved: testing never changes where any task is routed.
 */
export async function testProvider(deps: ConnectDeps, req: TestProviderRequest): Promise<ConnectResult> {
  const provider = req.provider as AiProvider;
  if (!(AI_PROVIDERS as readonly string[]).includes(provider) || provider === 'none') return { ok: false, message: 'Choose an AI provider.' };
  const label = PROVIDER_LABELS[provider];
  const keyVar = KEY_ENV_VAR[provider];
  const key = req.apiKey?.trim() ?? '';
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

  // A throwaway Ai over a private copy of the settings, routed at the provider under test. The stored row is never written.
  const stored = migrateAiSettings(deps.settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), deps.env());
  const baseUrl = req.baseUrl?.trim() || stored.providers[provider]?.baseUrl || null;
  const candidate = {
    providers: { [provider]: { dailyBudgetUsd: null, dailyCallLimit: null, ...stored.providers[provider], baseUrl } },
    tasks: { 'cv-extract': { provider, model: req.model.trim() || null } },
  };
  const overlay: SettingsStore = { ...deps.settings, get: (k, schema, fallback) => (k === AI_SETTINGS_KEY ? (candidate as never) : deps.settings.get(k, schema, fallback)) };
  const ai = createAi({ db: deps.db, settings: overlay, log: deps.log, env: deps.env, modelFactory: deps.modelFactory });
  const status = ai.taskStatus('cv-extract');
  if (!status.configured) return { ok: false, message: status.reason ?? 'AI is not configured.' };
  try {
    const out = await ai.generateObject({
      task: 'cv-extract',
      schema: z.object({ ok: z.boolean() }),
      system: 'You are a health check. Reply exactly as instructed.',
      prompt: 'Return {"ok": true}.',
      timeoutMs: 20_000,
    });
    return out.ok ? { ok: true, message: `Connected to ${label} (${status.model}).` } : { ok: false, message: 'The model answered, but not as expected.' };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  }
}
