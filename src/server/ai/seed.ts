import { AI_TASKS, DEFAULT_MODELS, QUALITY_TASKS, type AiProvider, type AiSettings } from './settings';

/**
 * What the setup wizard's task table starts with on a fresh install: every task on the first provider that is ready
 * (a key in .env, a ChatGPT sign-in, a Claude Code login), CV reading on Gemini 3 Flash when Google is ready.
 * Only on a genuinely fresh install (`fresh`: no saved AI settings row and the step never completed): a saved choice,
 * including a deliberate "None" everywhere, comes back as it is.
 */
export function seedTasks(current: AiSettings['tasks'], ready: AiProvider[], fresh: boolean): AiSettings['tasks'] {
  const usable = ready.filter((p): p is Exclude<AiProvider, 'none'> => p !== 'none');
  if (!fresh || !usable.length || AI_TASKS.some((t) => (current[t]?.provider ?? 'none') !== 'none')) return current;
  const routes = Object.fromEntries(
    AI_TASKS.map((t) => [t, { provider: usable[0], model: DEFAULT_MODELS[usable[0]][QUALITY_TASKS.includes(t) ? 'quality' : 'fast'] }]),
  ) as AiSettings['tasks'];
  if (usable.includes('google')) routes['cv-extract'] = { provider: 'google', model: DEFAULT_MODELS.google.fast };
  return routes;
}
