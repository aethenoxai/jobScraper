import { AI_TASKS, DEFAULT_MODELS, QUALITY_TASKS, type AiProvider, type AiSettings } from './settings';

/**
 * What the setup wizard's task table starts with on a fresh install: every task on the first provider that is ready
 * (a key in .env, a ChatGPT sign-in, a Claude Code login), CV reading on Gemini 3 Flash when Google is ready.
 * Tasks the user already routed are never overwritten: if any task uses a provider, the saved routes come back as they are.
 */
export function seedTasks(current: AiSettings['tasks'], ready: AiProvider[]): AiSettings['tasks'] {
  const usable = ready.filter((p): p is Exclude<AiProvider, 'none'> => p !== 'none');
  if (!usable.length || AI_TASKS.some((t) => (current[t]?.provider ?? 'none') !== 'none')) return current;
  const routes = Object.fromEntries(
    AI_TASKS.map((t) => [t, { provider: usable[0], model: DEFAULT_MODELS[usable[0]][QUALITY_TASKS.includes(t) ? 'quality' : 'fast'] }]),
  ) as AiSettings['tasks'];
  if (usable.includes('google')) routes['cv-extract'] = { provider: 'google', model: DEFAULT_MODELS.google.fast };
  return routes;
}
