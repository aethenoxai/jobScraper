import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, Output, streamText, type LanguageModel } from 'ai';
import { and, count, eq, gte, sum } from 'drizzle-orm';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';
import type { Db } from '../db';
import { aiUsage } from '../db/schema';
import type { Logger } from '../logging';
import type { SettingsStore } from '../settings';
import { CHATGPT_API_BASE, chatGptAccessToken, chatGptAccount } from './chatgpt-auth';
import { claudeCodeObject, findClaudeCode } from './claude-code';
import {
  AI_SETTINGS_KEY,
  KEY_ENV_VAR,
  ProviderConfigSchema,
  SUBSCRIPTION_PROVIDERS,
  migrateAiSettings,
  type AiProvider,
  type AiProviderConfig,
  type AiRoute,
  type AiTask,
  READS_FILES,
} from './settings';

export * from './settings';

export class AiNotConfiguredError extends Error {
  override name = 'AiNotConfiguredError';
}
export class AiBudgetExceededError extends Error {
  override name = 'AiBudgetExceededError';
}

export interface ProviderStatus {
  provider: AiProvider;
  configured: boolean;
  reason: string | null;
  keyEnvVar: string | null;
  keyPresent: boolean;
  baseUrl: string | null;
  spentTodayUsd: number;
  callsToday: number;
  dailyBudgetUsd: number | null;
  dailyCallLimit: number | null;
}

export interface TaskStatus {
  task: AiTask;
  provider: AiProvider;
  model: string | null;
  configured: boolean;
  reason: string | null;
}

export interface GenerateObjectRequest<T> {
  /** Which task this is: its provider and model come from the settings, and it labels the usage ledger. */
  task: AiTask;
  /** Names the call in the usage ledger and error messages instead of the task (e.g. a connection test). */
  label?: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /** The original document (e.g. the CV as PDF), for providers that read files; the others get the prompt only. */
  file?: { data: Uint8Array; mediaType: string };
  timeoutMs?: number;
  /** Cancels the call (e.g. the worker task was aborted). */
  signal?: AbortSignal;
}

export interface Ai {
  taskStatus(task: AiTask): TaskStatus;
  providerStatus(provider: AiProvider): ProviderStatus;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}

export type ModelFactory = (provider: Exclude<AiProvider, 'none'>, modelId: string, config: AiProviderConfig, env: Record<string, string | undefined>) => LanguageModel;

/** Rough list prices in USD per 1M tokens (input, output). Estimates only, used for the daily budget. */
const PRICES: Array<[RegExp, number, number]> = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 15, 75],
  // Gemini comes before /mini/i, which the word "gemini" itself matches.
  [/gemini-3-flash/i, 0.5, 3],
  [/gemini.*pro/i, 1.25, 10],
  [/flash/i, 0.3, 2.5],
  [/gpt-5-nano|gpt-4\.1-nano/i, 0.05, 0.4],
  [/mini/i, 0.25, 2],
  [/gpt-5|gpt-4\.1|gpt-4o/i, 1.25, 10],
];
const FALLBACK_PRICE: [number, number] = [3, 15];
/** Output tokens reserved against the budget while a call runs (a generous answer for our structured outputs). */
const RESERVED_OUTPUT_TOKENS = 2000;

export function estimateCostUsd(provider: AiProvider, model: string, inputTokens: number, outputTokens: number): number {
  // Local models cost nothing; subscriptions are paid through the user's plan.
  if (provider === 'ollama' || SUBSCRIPTION_PROVIDERS.includes(provider)) return 0;
  const [, inP, outP] = PRICES.find(([re]) => re.test(model)) ?? [null, ...FALLBACK_PRICE];
  return (inputTokens * inP + outputTokens * outP) / 1_000_000;
}

/** Google's key, under either of the names Google's own tools use. */
export const googleApiKey = (env: Record<string, string | undefined>) => env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;

export const defaultModelFactory: ModelFactory = (provider, modelId, config, env) => {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
    case 'google':
      return createGoogle({ apiKey: googleApiKey(env) })(modelId);
    case 'ollama':
      return createOllama({ baseURL: config.baseUrl ?? env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api' })(modelId);
    case 'openai-compatible':
      return createOpenAICompatible({ name: 'custom', baseURL: config.baseUrl ?? '', apiKey: env.OPENAI_COMPATIBLE_API_KEY })(modelId);
    case 'claude-code':
      throw new Error('Claude Code is run directly, not through a model factory.');
    case 'chatgpt':
      // The Responses API with the user's ChatGPT sign-in instead of an API key.
      return createOpenAI({ apiKey: env.CHATGPT_ACCESS_TOKEN, baseURL: CHATGPT_API_BASE }).responses(modelId);
  }
};

export function createAi(deps: {
  db: Db;
  settings: SettingsStore;
  log: Logger;
  /** The environment holding the keys; a function is asked on every use, so keys added to .env apply at once. */
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  now?: () => Date;
  modelFactory?: ModelFactory;
  /** Called (with the budget) whenever a provider's daily budget stops a call. */
  onBudgetExceeded?: (budgetUsd: number, provider: AiProvider) => void;
  /** Called (with the limit) whenever a plan provider's daily call limit stops a call. */
  onCallLimitReached?: (limit: number, provider: AiProvider) => void;
  /** Where the user's Claude Code is (default: found on the PATH). */
  claudeCodeBin?: () => string | null;
  /** Runs Claude Code (tests pass a stand-in). */
  runClaudeCode?: typeof claudeCodeObject;
  /** A fresh ChatGPT access token (default: from the stored sign-in, refreshed when needed). */
  chatgptAccessToken?: () => Promise<string>;
}): Ai {
  const chatgptToken = deps.chatgptAccessToken ?? (() => chatGptAccessToken(deps.settings));
  const claudeBin = deps.claudeCodeBin ?? (() => findClaudeCode());
  const runClaude = deps.runClaudeCode ?? claudeCodeObject;
  const readEnv = () => (typeof deps.env === 'function' ? deps.env() : (deps.env ?? process.env));
  const now = deps.now ?? (() => new Date());
  const factory = deps.modelFactory ?? defaultModelFactory;
  // Reads the stored row as-is and migrates it, so installs from before per-task routing keep working.
  const readSettings = () => migrateAiSettings(deps.settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), readEnv());
  const NO_ROUTE: AiRoute = { provider: 'none', model: null };
  const route = (task: AiTask): AiRoute => readSettings().tasks[task] ?? NO_ROUTE;
  const providerConfig = (provider: AiProvider): AiProviderConfig => readSettings().providers[provider] ?? ProviderConfigSchema.parse({});

  const startOfToday = () => {
    const start = now();
    start.setHours(0, 0, 0, 0);
    return start;
  };
  function spentToday(provider: AiProvider, db: Pick<Db, 'select'> = deps.db): number {
    const row = db.select({ total: sum(aiUsage.costUsd) }).from(aiUsage).where(and(gte(aiUsage.createdAt, startOfToday()), eq(aiUsage.provider, provider))).get();
    return Number(row?.total ?? 0);
  }
  function callsToday(provider: AiProvider, db: Pick<Db, 'select'> = deps.db): number {
    const row = db.select({ n: count() }).from(aiUsage).where(and(gte(aiUsage.createdAt, startOfToday()), eq(aiUsage.provider, provider))).get();
    return row?.n ?? 0;
  }

  function providerStatus(provider: AiProvider): ProviderStatus {
    const config = providerConfig(provider);
    const keyEnvVar = KEY_ENV_VAR[provider] ?? null;
    // Local OpenAI-compatible servers often take no key: only its address is required.
    const keyPresent = provider === 'none' ? false : provider === 'google' ? !!googleApiKey(readEnv()) : keyEnvVar && provider !== 'openai-compatible' ? !!readEnv()[keyEnvVar] : true;
    let reason: string | null = null;
    if (provider === 'none') reason = 'No AI provider selected.';
    else if (provider === 'claude-code' && !claudeBin()) reason = 'Claude Code isn’t installed on this computer. Install it and sign in with `claude auth login`.';
    else if (provider === 'chatgpt' && !chatGptAccount(deps.settings)) reason = 'Sign in with ChatGPT first.';
    else if (provider === 'chatgpt' && chatGptAccount(deps.settings)?.needsReconnect) reason = 'Sign in with ChatGPT again: OpenAI ended the earlier sign-in.';
    else if (!keyPresent) reason = `Add ${keyEnvVar} to your .env file.`;
    else if (provider === 'openai-compatible' && !config.baseUrl) reason = 'Enter the base URL of your OpenAI-compatible server.';
    return {
      provider,
      configured: reason === null,
      reason,
      keyEnvVar,
      keyPresent,
      baseUrl: config.baseUrl,
      spentTodayUsd: spentToday(provider),
      callsToday: callsToday(provider),
      dailyBudgetUsd: config.dailyBudgetUsd,
      dailyCallLimit: config.dailyCallLimit,
    };
  }

  function taskStatus(task: AiTask): TaskStatus {
    const { provider, model } = route(task);
    if (provider === 'none') return { task, provider, model: null, configured: false, reason: 'This task runs offline.' };
    const p = providerStatus(provider);
    const reason = !p.configured ? p.reason : !model ? 'Choose a model for this task.' : null;
    return { task, provider, model, configured: reason === null, reason };
  }

  return {
    taskStatus,
    providerStatus,
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
      const st = taskStatus(req.task);
      if (!st.configured) throw new AiNotConfiguredError(st.reason ?? 'AI is not configured.');
      const provider = st.provider as Exclude<AiProvider, 'none'>;
      const modelId = st.model!;
      const config = providerConfig(provider);
      // Check the budget and reserve this call's likely cost in one transaction: calls running side by side see
      // each other's reservations, so together they can't overspend. The row is corrected when the call ends.
      const reserved = estimateCostUsd(provider, modelId, Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 4), RESERVED_OUTPUT_TOKENS);
      const subscription = SUBSCRIPTION_PROVIDERS.includes(provider);
      const callLimit = subscription ? config.dailyCallLimit : null;
      let limitReached = false;
      const usageId = deps.db.transaction(
        (tx) => {
          if (callLimit !== null && callsToday(provider, tx) >= callLimit) {
            limitReached = true;
            return null;
          }
          if (config.dailyBudgetUsd !== null && spentToday(provider, tx) >= config.dailyBudgetUsd) return null;
          return tx.insert(aiUsage).values({ task: req.label ?? req.task, role: '', provider, model: modelId, inputTokens: 0, outputTokens: 0, costUsd: reserved, ok: false, createdAt: now() }).returning({ id: aiUsage.id }).get().id;
        },
        { behavior: 'immediate' },
      );
      if (usageId === null && limitReached) {
        deps.onCallLimitReached?.(callLimit!, provider);
        throw new AiBudgetExceededError(`Daily limit of ${callLimit} AI calls through your ${provider} plan reached. AI work resumes tomorrow.`);
      }
      if (usageId === null) {
        deps.onBudgetExceeded?.(config.dailyBudgetUsd!, provider);
        throw new AiBudgetExceededError(`Daily ${provider} budget of $${config.dailyBudgetUsd!.toFixed(2)} reached. AI work resumes tomorrow.`);
      }
      const record = (ok: boolean, input = 0, output = 0) =>
        deps.db
          .update(aiUsage)
          .set({ inputTokens: input, outputTokens: output, costUsd: estimateCostUsd(provider, modelId, input, output), ok })
          .where(eq(aiUsage.id, usageId))
          .run();

      const input =
        req.file && READS_FILES.has(provider)
          ? { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: req.prompt }, { type: 'file' as const, data: req.file.data, mediaType: req.file.mediaType }] }] }
          : { prompt: req.prompt };
      const abortSignal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 120_000)]) : AbortSignal.timeout(req.timeoutMs ?? 120_000);
      try {
        if (provider === 'claude-code') {
          const bin = claudeBin();
          if (!bin) throw new AiNotConfiguredError('Claude Code isn’t installed on this computer.');
          const r = await runClaude({ bin, model: modelId, system: req.system, prompt: req.prompt, schema: req.schema, signal: req.signal, timeoutMs: req.timeoutMs });
          record(true, r.inputTokens, r.outputTokens);
          return r.object;
        }
        if (provider === 'chatgpt') {
          // Plan usage takes streamed, unstored requests with the system text as instructions (no temperature or
          // output limit): developers.openai.com/siwc/token-sharing-open-source/preview-limitations.
          let streamError: unknown = null;
          const result = streamText({
            model: factory('chatgpt', modelId, config, { CHATGPT_ACCESS_TOKEN: await chatgptToken() }),
            output: Output.object({ schema: req.schema }),
            ...input,
            providerOptions: { openai: { store: false, instructions: req.system, systemMessageMode: 'remove' } },
            abortSignal,
            onError: ({ error }) => {
              streamError = error;
            },
          });
          let output: T;
          try {
            output = (await result.output) as T;
          } catch (err) {
            const cause = (streamError ?? err) as { statusCode?: number; responseBody?: string; message?: string };
            // The plan's own usage limit: pause AI like a used-up budget (work goes on with offline rules).
            if (cause.statusCode === 429 || /usage_limit_exceeded/.test(`${cause.responseBody ?? ''} ${cause.message ?? ''}`)) {
              throw new AiBudgetExceededError('Your ChatGPT plan’s usage limit is reached. AI work resumes when OpenAI allows it again.');
            }
            throw cause;
          }
          const usage = await result.usage;
          record(true, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
          return output;
        }
        const result = await generateText({
          model: factory(provider, modelId, config, readEnv()),
          output: Output.object({ schema: req.schema }),
          system: req.system,
          ...input,
          abortSignal,
        });
        record(true, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0);
        return result.output as T;
      } catch (err) {
        record(false);
        // Log only the message: provider errors carry the request body (CV text) and headers.
        deps.log.warn({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), task: req.label ?? req.task, provider, model: modelId }, 'AI call failed');
        if (err instanceof AiBudgetExceededError || err instanceof AiNotConfiguredError) throw err;
        // Name the route (not the prompt or key) so a retired or misspelt model is easy to spot.
        throw new Error(`${req.label ?? req.task} · ${provider} · ${modelId}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },
  };
}
