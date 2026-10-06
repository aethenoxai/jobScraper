/**
 * Pure helpers behind Settings → AI → Providers: what each row says, which tasks a missing key would break,
 * and how the card's form changes the saved settings. No I/O, so it is unit-tested directly.
 */
import { AI_PROVIDERS, AI_TASKS, DEFAULT_MODELS, PROVIDER_LABELS, ProviderConfigSchema, SUBSCRIPTION_PROVIDERS, TASK_LABELS, type AiProvider, type AiSettings } from './settings';
import type { ModelList } from './models';

/** The slice of `ProviderStatus` the card needs (kept structural so this file doesn't import the Ai factory). */
export interface ProviderStatusLike {
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

export interface ProviderRow {
  provider: Exclude<AiProvider, 'none'>;
  label: string;
  keyEnvVar: string | null;
  keyPresent: boolean;
  needsBaseUrl: boolean;
  baseUrl: string | null;
  /** 'usd' = budget in dollars; 'calls' = calls per day through the user's plan. */
  limitKind: 'usd' | 'calls';
  limit: number | null;
  usedToday: string;
  /** Plain-words warning when a task is routed here but the provider can't run it yet; otherwise null. */
  warning: string | null;
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function providerRows(statuses: ProviderStatusLike[], settings: AiSettings): ProviderRow[] {
  return statuses
    .filter((s): s is ProviderStatusLike & { provider: ProviderRow['provider'] } => s.provider !== 'none')
    .map((s) => {
      const subscription = SUBSCRIPTION_PROVIDERS.includes(s.provider);
      const titles = AI_TASKS.filter((t) => settings.tasks[t]?.provider === s.provider).map((t) => TASK_LABELS[t].title.toLowerCase());
      return {
        provider: s.provider,
        label: PROVIDER_LABELS[s.provider],
        keyEnvVar: s.keyEnvVar,
        keyPresent: s.keyPresent,
        needsBaseUrl: s.provider === 'ollama' || s.provider === 'openai-compatible',
        baseUrl: s.baseUrl,
        limitKind: subscription ? 'calls' : 'usd',
        limit: subscription ? s.dailyCallLimit : s.dailyBudgetUsd,
        usedToday: subscription ? `${s.callsToday} calls` : `$${s.spentTodayUsd.toFixed(3)} (${s.callsToday} calls)`,
        warning: titles.length && !s.configured ? `Not ready, but used for ${list(titles)}: ${s.reason ?? 'check the settings'}` : null,
      };
    });
}

/** A note about the model list, only when the live fetch failed. Never shows the raw error. */
export function modelNote(provider: AiProvider, models: ModelList): string | null {
  if (models.source === 'live') return null;
  return models.error ? `Couldn’t reach ${PROVIDER_LABELS[provider].split(' (')[0]}: showing known models.` : null;
}

/** The model a connection test uses: the one a task already routes here, else the provider's default. */
export function testModelFor(provider: Exclude<AiProvider, 'none'>, settings: AiSettings): string {
  const routed = AI_TASKS.map((t) => settings.tasks[t]).find((r) => r?.provider === provider && r.model);
  return routed?.model ?? DEFAULT_MODELS[provider].fast ?? '';
}

/**
 * Applies the card's fields (`<provider>.baseUrl`, `<provider>.limit`) to the saved settings. A field that isn't
 * in the form leaves that provider alone; an empty one clears it (no limit / no address). Throws a readable Error.
 */
export function applyProviderForm(current: AiSettings, form: Record<string, string>): AiSettings {
  const providers = { ...current.providers };
  for (const p of AI_PROVIDERS) {
    if (p === 'none' || !(`${p}.limit` in form || `${p}.baseUrl` in form)) continue;
    const prev = providers[p] ?? ProviderConfigSchema.parse({});
    const next = { ...prev };
    if (`${p}.baseUrl` in form) {
      const url = form[`${p}.baseUrl`].trim();
      if (url && !(URL.canParse(url) && /^https?:$/.test(new URL(url).protocol))) throw new Error(`${PROVIDER_LABELS[p]}: the server address must be a full http(s) URL.`);
      next.baseUrl = url || null;
    }
    if (`${p}.limit` in form) {
      const raw = form[`${p}.limit`].trim();
      const n = raw === '' ? null : Number(raw);
      const calls = SUBSCRIPTION_PROVIDERS.includes(p);
      if (n !== null && (!Number.isFinite(n) || n < (calls ? 1 : 0) || (calls && !Number.isInteger(n)))) throw new Error(`${PROVIDER_LABELS[p]}: the daily limit must be ${calls ? 'a whole number of calls (1 or more)' : 'a dollar amount (0 or more)'}.`);
      if (calls) next.dailyCallLimit = n;
      else next.dailyBudgetUsd = n;
    }
    providers[p] = ProviderConfigSchema.parse(next);
  }
  return { ...current, providers };
}
