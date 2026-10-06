/**
 * Helpers behind Settings → AI → Providers: what each row says, which tasks a missing key would break,
 * and how the forms change the saved settings. Server-side only (updateAiSettings touches the settings store);
 * the client table imports from ./task-rows instead. Apart from updateAiSettings, pure and unit-tested directly.
 */
import { AI_PROVIDERS, AI_TASKS, DEFAULT_MODELS, PROVIDER_LABELS, ProviderConfigSchema, SUBSCRIPTION_PROVIDERS, TASK_LABELS, type AiProvider, type AiRoute, type AiSettings, type AiTask } from './settings';
import type { ModelList } from './models';
import type { SettingsStore } from '../settings';
import { z } from 'zod';
import { AI_SETTINGS_KEY, migrateAiSettings } from './settings';

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

/** True once today's use has hit the provider's daily limit (calls for plan providers, dollars for keyed ones), the same test `generateObject` applies. */
export function limitReached(s: ProviderStatusLike): boolean {
  if (SUBSCRIPTION_PROVIDERS.includes(s.provider)) return s.dailyCallLimit !== null && s.callsToday >= s.dailyCallLimit;
  return s.dailyBudgetUsd !== null && s.spentTodayUsd >= s.dailyBudgetUsd;
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
        warning: !titles.length ? null : !s.configured ? `Not ready, but used for ${list(titles)}: ${s.reason ?? 'check the settings'}` : limitReached(s) ? `Today’s limit is reached: ${list(titles)} run on offline rules until tomorrow.` : null,
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

const ADDRESS_PROVIDERS: readonly AiProvider[] = ['ollama', 'openai-compatible'];

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
    // Only local and compatible servers take an address; for any other provider it would be a place to send the real key.
    if (`${p}.baseUrl` in form && !ADDRESS_PROVIDERS.includes(p)) next.baseUrl = null;
    else if (`${p}.baseUrl` in form) {
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

/** The address a connection test may use. Only local and compatible servers take one: for any other provider a client-supplied address would receive the real key from .env. */
export function testBaseUrl(provider: AiProvider, baseUrl: string): string | undefined {
  return (provider === 'ollama' || provider === 'openai-compatible') && baseUrl.trim() ? baseUrl.trim() : undefined;
}

const TASK_FIELD = /^tasks\.([^.]+)\.(provider|model)$/;

/**
 * Applies the routing table (`tasks.<id>.provider`, `tasks.<id>.model`) to the saved settings. A field that isn't
 * in the form keeps its stored value. If a task's provider changes and the form carries no model, the old model is
 * dropped (it belonged to the old provider). "None" never keeps a model. Unknown task or provider ids throw
 * rather than being written. Pure and idempotent: the same form applied twice gives the same settings.
 */
export function applyTaskForm(current: AiSettings, form: Record<string, string>): AiSettings {
  const tasks = { ...current.tasks };
  const seen = new Map<AiTask, { provider?: string; model?: string }>();
  for (const [key, value] of Object.entries(form)) {
    if (!key.startsWith('tasks.')) continue;
    const m = TASK_FIELD.exec(key);
    if (!m || !(AI_TASKS as readonly string[]).includes(m[1])) throw new Error('The form names a task that doesn’t exist.');
    seen.set(m[1] as AiTask, { ...seen.get(m[1] as AiTask), [m[2]]: value });
  }
  for (const [task, f] of seen) {
    const prev: AiRoute = tasks[task] ?? { provider: 'none', model: null };
    if (f.provider !== undefined && !(AI_PROVIDERS as readonly string[]).includes(f.provider)) throw new Error('The form names an AI provider that doesn’t exist.');
    const provider = (f.provider ?? prev.provider) as AiProvider;
    const model = f.model !== undefined ? f.model.trim().slice(0, 200) || null : provider === prev.provider ? prev.model : null;
    tasks[task] = { provider, model: provider === 'none' ? null : model };
  }
  return { ...current, tasks };
}

/** One honest line for the top of the page: what runs on AI, what is offline, what is stuck. */
export function aiStateLine(tasks: Array<{ task: AiTask; provider: AiProvider; configured: boolean }>, exhausted: ReadonlySet<AiProvider>): string {
  const title = (t: AiTask) => TASK_LABELS[t].title.toLowerCase();
  const ready = tasks.filter((t) => t.provider !== 'none' && t.configured && !exhausted.has(t.provider));
  const paused = tasks.filter((t) => t.provider !== 'none' && t.configured && exhausted.has(t.provider));
  const stuck = tasks.filter((t) => t.provider !== 'none' && !t.configured);
  const offline = tasks.filter((t) => t.provider === 'none');
  if (ready.length === tasks.length) return `All ${tasks.length} tasks run on AI.`;
  if (ready.length + paused.length + stuck.length === 0) return 'Offline: no task uses AI, so Job Scraper works with simpler rule-based extraction and matching.';
  const parts = [`${ready.length} of ${tasks.length} tasks run on AI.`];
  if (offline.length) parts.push(`Offline by choice: ${list(offline.map((t) => title(t.task)))}.`);
  if (stuck.length) parts.push(`Not ready, so on offline rules for now: ${list(stuck.map((t) => title(t.task)))}.`);
  if (paused.length) parts.push(`Daily limit reached, on offline rules until tomorrow: ${list(paused.map((t) => title(t.task)))}.`);
  return parts.join(' ');
}

/** Changes the saved AI settings in one immediate transaction, so two saves racing each other can't drop one another's changes. */
export function updateAiSettings(settings: SettingsStore, env: Record<string, string | undefined>, change: (current: AiSettings) => AiSettings): void {
  settings.update(AI_SETTINGS_KEY, z.unknown(), undefined, (raw) => change(migrateAiSettings(raw, env)));
}
