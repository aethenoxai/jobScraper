import type { Db } from '../../src/server/db';
import { AI_SETTINGS_KEY, createAi, DEFAULT_MODELS, type AiProvider, type AiTask } from '../../src/server/ai';
import type { Logger } from '../../src/server/logging';
import { createSettings } from '../../src/server/settings';

/**
 * An Ai whose given tasks all run on EVAL_AI_PROVIDER (default openai) with EVAL_AI_MODEL (or the provider's default),
 * or EVAL_AI_QUALITY_MODEL for the tasks listed under `quality`. Exits with code 2 when a task is not configured.
 * `label` names the provider and the model of the eval's main task.
 */
export function evalAi(db: Db, log: Logger, tasks: { fast?: AiTask[]; quality?: AiTask[] }) {
  const provider = (process.env.EVAL_AI_PROVIDER ?? 'openai') as Exclude<AiProvider, 'none'>;
  const defaults = DEFAULT_MODELS[provider] ?? { fast: null, quality: null };
  const fast = process.env.EVAL_AI_MODEL ?? defaults.fast;
  const quality = process.env.EVAL_AI_QUALITY_MODEL ?? defaults.quality;
  const route = (model: string | null) => ({ provider, model });
  const settings = createSettings(db);
  settings.set(AI_SETTINGS_KEY, {
    providers: { [provider]: { baseUrl: process.env.EVAL_AI_BASE_URL ?? null, dailyBudgetUsd: null, dailyCallLimit: null } },
    tasks: { ...Object.fromEntries((tasks.fast ?? []).map((t) => [t, route(fast)])), ...Object.fromEntries((tasks.quality ?? []).map((t) => [t, route(quality)])) },
  });
  const ai = createAi({ db, settings, log });
  for (const t of [...(tasks.fast ?? []), ...(tasks.quality ?? [])]) {
    const st = ai.taskStatus(t);
    if (!st.configured) {
      console.error(`AI not configured for ${t}: ${st.reason}`);
      process.exit(2);
    }
  }
  return { ai, provider, fast, quality };
}
