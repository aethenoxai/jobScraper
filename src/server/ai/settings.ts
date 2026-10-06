import { z } from 'zod';

export const AI_SETTINGS_KEY = 'ai';
export const AI_PROVIDERS = ['none', 'openai', 'anthropic', 'google', 'ollama', 'openai-compatible', 'claude-code', 'chatgpt'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// Old schema, kept for migrations only
const OldAiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  fastModel: z.string().trim().min(1).nullable(),
  qualityModel: z.string().trim().min(1).nullable(),
  baseUrl: z.string().trim().url().nullable(),
  dailyBudgetUsd: z.number().min(0).nullable(),
  dailyCallLimit: z.number().int().min(1).nullable().default(300),
});
export type OldAiSettings = z.infer<typeof OldAiSettingsSchema>;

export const AI_TASKS = ['cv-extract', 'jd-analysis', 'match-evaluate', 'web-job-extract', 'cv-tailor', 'cover-letter', 'form-answers', 'inbox-classify'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Which tasks used the "quality" model before per-task routing; the rest used "fast". */
export const QUALITY_TASKS: readonly AiTask[] = ['cv-tailor', 'cover-letter'];

export const TASK_LABELS: Record<AiTask, { title: string; hint: string }> = {
  'cv-extract': { title: 'Reading your CV', hint: 'Without AI: you fill the profile in yourself.' },
  'jd-analysis': { title: 'Understanding a job post', hint: 'Without AI: simpler rule-based requirements.' },
  'match-evaluate': { title: 'Scoring a match', hint: 'Without AI: offline heuristic score.' },
  'web-job-extract': { title: 'Reading a job page', hint: 'Without AI: pages without structured data are skipped.' },
  'cv-tailor': { title: 'Tailoring your CV', hint: 'Without AI: a template CV from your profile.' },
  'cover-letter': { title: 'Writing a cover letter', hint: 'Without AI: a template letter.' },
  'form-answers': { title: 'Answering application forms', hint: 'Without AI: unmapped fields are left blank.' },
  'inbox-classify': { title: 'Sorting your inbox', hint: 'Without AI: rule-based classification.' },
};

const RouteSchema = z.object({ provider: z.enum(AI_PROVIDERS), model: z.string().trim().min(1).nullable() });
export const ProviderConfigSchema = z.object({
  baseUrl: z.string().trim().url().nullable().default(null),
  dailyBudgetUsd: z.number().min(0).nullable().default(2),
  dailyCallLimit: z.number().int().min(1).nullable().default(300),
});

export const AiSettingsSchema = z.object({
  providers: z.partialRecord(z.enum(AI_PROVIDERS), ProviderConfigSchema).default({}),
  tasks: z.partialRecord(z.enum(AI_TASKS), RouteSchema).default({}),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export type AiProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type AiRoute = z.infer<typeof RouteSchema>;

const OFFLINE: AiRoute = { provider: 'none', model: null };
export const DEFAULT_AI_SETTINGS: AiSettings = {
  providers: {},
  tasks: Object.fromEntries(AI_TASKS.map((t) => [t, OFFLINE])) as Record<AiTask, AiRoute>,
};

/** Providers paid through the user's own plan: no money is counted, calls are (dailyCallLimit). */
export const SUBSCRIPTION_PROVIDERS: readonly AiProvider[] = ['claude-code', 'chatgpt'];

/** OD-4 defaults; users can override per role in Settings → AI. */
export const DEFAULT_MODELS: Record<Exclude<AiProvider, 'none'>, { fast: string | null; quality: string | null }> = {
  openai: { fast: 'gpt-5-mini', quality: 'gpt-5' },
  anthropic: { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5-5' },
  google: { fast: 'gemini-3-flash-preview', quality: 'gemini-2.5-pro' },
  ollama: { fast: 'llama3.1', quality: 'llama3.1' },
  'openai-compatible': { fast: null, quality: null },
  // Claude Code's model names follow the newest model of each family.
  'claude-code': { fast: 'haiku', quality: 'sonnet' },
  chatgpt: { fast: 'gpt-5-mini', quality: 'gpt-5' },
};

/** Models offered in setup and settings (the user can also type another one). Empty: type the model's name. */
export const MODEL_CHOICES: Record<Exclude<AiProvider, 'none'>, string[]> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  google: ['gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: [],
  'openai-compatible': [],
  'claude-code': ['sonnet', 'opus', 'haiku'],
  chatgpt: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
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
  'claude-code': 'Claude (through your Claude Code)',
  chatgpt: 'ChatGPT (sign in with your plan)',
};

/**
 * Reads either shape: the new one as-is, the pre-routing one converted. Never throws.
 * Fills gaps in partial new-shape rows with offline routes; corrupt rows degrade to default.
 */
export function migrateAiSettings(raw: unknown, env: Record<string, string | undefined>): AiSettings {
  // Check if raw looks like new shape (has tasks or providers property).
  const looksLikeNewShape = typeof raw === 'object' && raw !== null && ('tasks' in raw || 'providers' in raw);
  if (looksLikeNewShape) {
    // Try to parse as new shape; on failure, fall through to old shape.
    const asNew = AiSettingsSchema.safeParse(raw);
    if (asNew.success) {
      // Fill missing tasks with offline routes.
      const filledTasks: Record<string, AiRoute> = { ...asNew.data.tasks };
      for (const t of AI_TASKS) {
        if (!(t in filledTasks)) {
          filledTasks[t] = OFFLINE;
        }
      }
      return AiSettingsSchema.parse({ providers: asNew.data.providers, tasks: filledTasks });
    }
    // New shape validation failed; fall through to try old shape.
  }
  // Try old shape (e.g., { provider: 'claude-code', fastModel: '...', ... }).
  const old = OldAiSettingsSchema.safeParse(raw);
  if (!old.success) return DEFAULT_AI_SETTINGS;
  const { provider, fastModel, qualityModel, baseUrl, dailyBudgetUsd, dailyCallLimit } = old.data;
  const defaults = provider === 'none' ? { fast: null, quality: null } : DEFAULT_MODELS[provider];
  const route = (q: boolean): AiRoute => (provider === 'none' ? OFFLINE : { provider, model: (q ? qualityModel ?? defaults.quality : fastModel ?? defaults.fast) ?? null });
  const tasks = Object.fromEntries(AI_TASKS.map((t) => [t, route(QUALITY_TASKS.includes(t))])) as Record<AiTask, AiRoute>;
  const providers: Record<string, AiProviderConfig> = provider === 'none' ? {} : { [provider]: { baseUrl, dailyBudgetUsd, dailyCallLimit } };
  // D-30: CV reading seeds to Gemini 3 Flash where a key exists AND provider is not offline.
  if (provider !== 'none' && (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY)) {
    tasks['cv-extract'] = { provider: 'google', model: 'gemini-3-flash-preview' };
    providers.google = { baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 };
  }
  return AiSettingsSchema.parse({ providers, tasks });
}
