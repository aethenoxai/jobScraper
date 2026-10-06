import type { Ai, AiTask, GenerateObjectRequest, ProviderStatus, TaskStatus } from './index';

/**
 * The status half of a test double for `Ai`: only the listed tasks have a provider, every other task runs
 * offline, so a test can't pass by accident because some other task happens to be configured.
 * `providers` overrides what a provider reports (budget, calls); tasks route to provider `openai`.
 */
export function fakeRoutes(configured: AiTask[], providers: Partial<ProviderStatus> = {}): Pick<Ai, 'taskStatus' | 'providerStatus'> {
  return {
    taskStatus: (task): TaskStatus => {
      const on = configured.includes(task);
      return { task, provider: on ? 'openai' : 'none', model: on ? 'test-model' : null, configured: on, reason: on ? null : 'This task runs offline.' };
    },
    providerStatus: (provider): ProviderStatus => ({ provider, configured: provider !== 'none', reason: null, keyEnvVar: null, keyPresent: true, baseUrl: null, spentTodayUsd: 0, callsToday: 0, dailyBudgetUsd: null, dailyCallLimit: null, ...providers }),
  };
}

/** A full `Ai` double: `fakeRoutes` plus a `generateObject` that fails if the call names a task this fake isn't configured for. */
export function routedAi(configured: AiTask[], generate: (req: GenerateObjectRequest<never>) => unknown, providers: Partial<ProviderStatus> = {}): Ai {
  return {
    ...fakeRoutes(configured, providers),
    generateObject: (async (req: GenerateObjectRequest<never>) => {
      if (!configured.includes(req.task)) throw new Error(`generateObject was sent task '${req.task}', but this fake is configured for ${configured.join(', ')}`);
      return generate(req);
    }) as Ai['generateObject'],
  };
}
