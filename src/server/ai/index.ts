import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, Output, type LanguageModel } from 'ai';
import { eq, gte, sum } from 'drizzle-orm';
import { createOllama } from 'ollama-ai-provider-v2';
import type { z } from 'zod';
import type { Db } from '../db';
import { aiUsage } from '../db/schema';
import type { Logger } from '../logging';
import type { SettingsStore } from '../settings';
import {
  AI_SETTINGS_KEY,
  AiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  DEFAULT_MODELS,
  KEY_ENV_VAR,
  type AiProvider,
  type AiSettings,
  type ModelRole,
} from './settings';

export * from './settings';

export class AiNotConfiguredError extends Error {
  override name = 'AiNotConfiguredError';
}
export class AiBudgetExceededError extends Error {
  override name = 'AiBudgetExceededError';
}

export interface AiStatus {
  provider: AiProvider;
  configured: boolean;
  reason: string | null;
  models: { fast: string | null; quality: string | null };
  keyEnvVar: string | null;
  keyPresent: boolean;
  spentTodayUsd: number;
  dailyBudgetUsd: number | null;
}

export interface GenerateObjectRequest<T> {
  role: ModelRole;
  /** Short label for the usage ledger, e.g. "cv-extract". */
  task: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  timeoutMs?: number;
  /** Cancels the call (e.g. the worker task was aborted). */
  signal?: AbortSignal;
}

export interface Ai {
  status(): AiStatus;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}

export type ModelFactory = (provider: Exclude<AiProvider, 'none'>, modelId: string, settings: AiSettings, env: Record<string, string | undefined>) => LanguageModel;

/** Rough list prices in USD per 1M tokens (input, output). Estimates only, used for the daily budget. */
const PRICES: Array<[RegExp, number, number]> = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 15, 75],
  [/gpt-5-nano|gpt-4\.1-nano/i, 0.05, 0.4],
  [/mini/i, 0.25, 2],
  [/gpt-5|gpt-4\.1|gpt-4o/i, 1.25, 10],
  [/flash/i, 0.3, 2.5],
  [/gemini.*pro/i, 1.25, 10],
];
const FALLBACK_PRICE: [number, number] = [3, 15];
/** Output tokens reserved against the budget while a call runs (a generous answer for our structured outputs). */
const RESERVED_OUTPUT_TOKENS = 2000;

export function estimateCostUsd(provider: AiProvider, model: string, inputTokens: number, outputTokens: number): number {
  if (provider === 'ollama') return 0;
  const [, inP, outP] = PRICES.find(([re]) => re.test(model)) ?? [null, ...FALLBACK_PRICE];
  return (inputTokens * inP + outputTokens * outP) / 1_000_000;
}

export const defaultModelFactory: ModelFactory = (provider, modelId, settings, env) => {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
    case 'google':
      return createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(modelId);
    case 'ollama':
      return createOllama({ baseURL: settings.baseUrl ?? env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api' })(modelId);
    case 'openai-compatible':
      return createOpenAICompatible({ name: 'custom', baseURL: settings.baseUrl ?? '', apiKey: env.OPENAI_COMPATIBLE_API_KEY })(modelId);
  }
};

export function createAi(deps: {
  db: Db;
  settings: SettingsStore;
  log: Logger;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  modelFactory?: ModelFactory;
  /** Called (with the budget) whenever the daily budget stops a call. */
  onBudgetExceeded?: (budgetUsd: number) => void;
}): Ai {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const factory = deps.modelFactory ?? defaultModelFactory;
  const readSettings = () => deps.settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);

  function spentToday(db: Pick<Db, 'select'> = deps.db): number {
    const start = now();
    start.setHours(0, 0, 0, 0);
    const row = db.select({ total: sum(aiUsage.costUsd) }).from(aiUsage).where(gte(aiUsage.createdAt, start)).get();
    return Number(row?.total ?? 0);
  }

  function status(): AiStatus {
    const s = readSettings();
    const base = { provider: s.provider, spentTodayUsd: spentToday(), dailyBudgetUsd: s.dailyBudgetUsd };
    if (s.provider === 'none') {
      return { ...base, configured: false, reason: 'No AI provider selected.', models: { fast: null, quality: null }, keyEnvVar: null, keyPresent: false };
    }
    const defaults = DEFAULT_MODELS[s.provider];
    const models = { fast: s.fastModel ?? defaults.fast, quality: s.qualityModel ?? defaults.quality };
    const keyEnvVar = KEY_ENV_VAR[s.provider] ?? null;
    // Local OpenAI-compatible servers often take no key: only its address is required.
    const keyPresent = keyEnvVar && s.provider !== 'openai-compatible' ? !!env[keyEnvVar] : true;
    let reason: string | null = null;
    if (!keyPresent) reason = `Add ${keyEnvVar} to your .env file and restart Job Scraper.`;
    else if (!models.fast || !models.quality) reason = 'Enter model names for this provider.';
    else if (s.provider === 'openai-compatible' && !s.baseUrl) reason = 'Enter the base URL of your OpenAI-compatible server.';
    return { ...base, configured: reason === null, reason, models, keyEnvVar, keyPresent };
  }

  return {
    status,
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
      const s = readSettings();
      const st = status();
      if (!st.configured || s.provider === 'none') throw new AiNotConfiguredError(st.reason ?? 'AI is not configured.');
      const modelId = st.models[req.role]!;
      // Check the budget and reserve this call's likely cost in one transaction: calls running side by side see
      // each other's reservations, so together they can't overspend. The row is corrected when the call ends.
      const reserved = estimateCostUsd(s.provider, modelId, Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 4), RESERVED_OUTPUT_TOKENS);
      const usageId = deps.db.transaction(
        (tx) => {
          if (st.dailyBudgetUsd !== null && spentToday(tx) >= st.dailyBudgetUsd) return null;
          return tx.insert(aiUsage).values({ task: req.task, role: req.role, provider: s.provider, model: modelId, inputTokens: 0, outputTokens: 0, costUsd: reserved, ok: false, createdAt: now() }).returning({ id: aiUsage.id }).get().id;
        },
        { behavior: 'immediate' },
      );
      if (usageId === null) {
        deps.onBudgetExceeded?.(st.dailyBudgetUsd!);
        throw new AiBudgetExceededError(`Daily AI budget of $${st.dailyBudgetUsd!.toFixed(2)} reached. AI work resumes tomorrow.`);
      }
      const record = (ok: boolean, input = 0, output = 0) =>
        deps.db
          .update(aiUsage)
          .set({ inputTokens: input, outputTokens: output, costUsd: estimateCostUsd(s.provider, modelId, input, output), ok })
          .where(eq(aiUsage.id, usageId))
          .run();

      try {
        const result = await generateText({
          model: factory(s.provider, modelId, s, env),
          output: Output.object({ schema: req.schema }),
          system: req.system,
          prompt: req.prompt,
          abortSignal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 120_000)]) : AbortSignal.timeout(req.timeoutMs ?? 120_000),
        });
        record(true, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0);
        return result.output as T;
      } catch (err) {
        record(false);
        // Log only the message: provider errors carry the request body (CV text) and headers.
        deps.log.warn({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), task: req.task, provider: s.provider, model: modelId }, 'AI call failed');
        throw err;
      }
    },
  };
}
