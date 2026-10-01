import { z } from 'zod';

export const AI_SETTINGS_KEY = 'ai';
export const AI_PROVIDERS = ['none', 'openai', 'anthropic', 'google', 'ollama', 'openai-compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type ModelRole = 'fast' | 'quality';

export const AiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  /** Override of the provider's default "fast" model (matching, extraction). */
  fastModel: z.string().trim().min(1).nullable(),
  /** Override of the provider's default "quality" model (CV tailoring, cover letters). */
  qualityModel: z.string().trim().min(1).nullable(),
  /** Base URL for Ollama or an OpenAI-compatible server. */
  baseUrl: z.string().trim().url().nullable(),
  /** Stop AI calls for the rest of the day once this much (USD, estimated) is spent. Null = no limit. */
  dailyBudgetUsd: z.number().min(0).nullable(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'none',
  fastModel: null,
  qualityModel: null,
  baseUrl: null,
  dailyBudgetUsd: 2,
};

/** OD-4 defaults; users can override per role in Settings → AI. */
export const DEFAULT_MODELS: Record<Exclude<AiProvider, 'none'>, { fast: string | null; quality: string | null }> = {
  openai: { fast: 'gpt-5-mini', quality: 'gpt-5' },
  anthropic: { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5-5' },
  google: { fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro' },
  ollama: { fast: 'llama3.1', quality: 'llama3.1' },
  'openai-compatible': { fast: null, quality: null },
};

/** Models offered in setup and settings (the user can also type another one). Empty: type the model's name. */
export const MODEL_CHOICES: Record<Exclude<AiProvider, 'none'>, string[]> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: [],
  'openai-compatible': [],
};

/** Env var holding each provider's API key. Keys live only in .env (PRD §37). */
export const KEY_ENV_VAR: Partial<Record<AiProvider, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  none: 'None (offline heuristics only)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama (local models)',
  'openai-compatible': 'OpenAI-compatible server',
};

/**
 * Applies a submitted settings form on top of the current settings. Fields the form didn't send are kept
 * (so hiding the budget field never removes the budget); model overrides are cleared when the provider changes.
 */
export function mergeAiSettings(current: AiSettings, form: Record<string, string | undefined>): AiSettings {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(form, k);
  const text = (k: string) => {
    const v = (form[k] ?? '').trim();
    return v === '' ? null : v;
  };
  const provider = has('provider') ? form.provider : current.provider;
  const providerChanged = provider !== current.provider;
  const next = {
    provider,
    fastModel: has('fastModel') ? text('fastModel') : providerChanged ? null : current.fastModel,
    qualityModel: has('qualityModel') ? text('qualityModel') : providerChanged ? null : current.qualityModel,
    baseUrl: has('baseUrl') ? text('baseUrl') : providerChanged ? null : current.baseUrl,
    dailyBudgetUsd: has('dailyBudgetUsd') ? (text('dailyBudgetUsd') === null ? null : Number(form.dailyBudgetUsd)) : current.dailyBudgetUsd,
  };
  return AiSettingsSchema.parse(next);
}
