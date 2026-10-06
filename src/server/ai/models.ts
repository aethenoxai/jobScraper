import { createHash } from 'node:crypto';
import { googleApiKey } from './index';
import { KEY_ENV_VAR, MODEL_CHOICES, type AiProvider } from './settings';

export type ModelList = { models: string[]; source: 'live' | 'fallback'; error?: string };
type Opts = { env: Record<string, string | undefined>; baseUrl?: string | null; now?: () => number; fetch?: typeof fetch };

const TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 45_000; // a dead provider must not cost 10 s on every render
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const OPENAI_BASE = 'https://api.openai.com/v1';

// On globalThis: Next route bundles each get their own module instance.
const g = globalThis as { __jobScraperModelCache?: Map<string, { at: number; ttl: number; value: ModelList }> };
const cache = () => (g.__jobScraperModelCache ??= new Map());

const staticList = (provider: AiProvider): string[] => (provider === 'none' ? [] : MODEL_CHOICES[provider]);
const fallback = (provider: AiProvider, error?: string): ModelList => ({ models: staticList(provider), source: 'fallback', ...(error ? { error } : {}) });
const names = (xs: unknown, pick: (x: Record<string, unknown>) => unknown): string[] =>
  (Array.isArray(xs) ? xs : []).map((x) => pick(x ?? {})).filter((s): s is string => typeof s === 'string' && s.length > 0);

/** Where to ask, with what, and how to read the answer. The URL and headers carry the key: never log them. */
function request(provider: AiProvider, env: Opts['env'], baseUrl?: string | null) {
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  switch (provider) {
    case 'google': {
      const key = googleApiKey(env);
      if (!key) return 'Add a Google API key to see the live model list.';
      return { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`, headers: {},
        read: (b: Record<string, unknown>) => (Array.isArray(b.models) ? b.models : [])
          .filter((m: Record<string, unknown>) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m: Record<string, unknown>) => String(m.name ?? '').replace(/^models\//, '')).filter(Boolean) };
    }
    case 'openai': {
      const key = env[KEY_ENV_VAR.openai!];
      if (!key) return 'Add an OpenAI API key to see the live model list.';
      return { url: `${OPENAI_BASE}/models`, headers: { Authorization: `Bearer ${key}` }, read: (b: Record<string, unknown>) => names(b.data, (x) => x.id) };
    }
    case 'anthropic': {
      const key = env[KEY_ENV_VAR.anthropic!];
      if (!key) return 'Add an Anthropic API key to see the live model list.';
      return { url: 'https://api.anthropic.com/v1/models?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, read: (b: Record<string, unknown>) => names(b.data, (x) => x.id) };
    }
    case 'ollama':
      if (!base) return 'Set the Ollama address to see the live model list.';
      return { url: `${base.replace(/\/api$/, '')}/api/tags`, headers: {}, read: (b: Record<string, unknown>) => names(b.models, (x) => x.name) };
    case 'openai-compatible': {
      if (!base) return 'Set the server address to see the live model list.';
      const key = env[KEY_ENV_VAR['openai-compatible']!];
      return { url: `${base}/models`, headers: key ? { Authorization: `Bearer ${key}` } : {}, read: (b: Record<string, unknown>) => names(b.data, (x) => x.id) };
    }
    default:
      return null; // claude-code, chatgpt, none: static
  }
}

/** The models a provider offers. Never throws; any failure gives the built-in list. Web process only. */
export async function listModels(provider: AiProvider, opts: Opts): Promise<ModelList> {
  try {
    const req = request(provider, opts.env, opts.baseUrl);
    if (req === null) return fallback(provider);
    if (typeof req === 'string') return fallback(provider, req);
    const now = (opts.now ?? Date.now)();
    // The key is part of the cache key (hashed, never raw): a changed key must not see the old account's list.
    const id = `${provider}|${provider === 'openai' ? '' : opts.baseUrl ?? ''}|${hash(req.url + JSON.stringify(req.headers))}`;
    const hit = cache().get(id);
    if (hit && now - hit.at < hit.ttl) return hit.value;
    const remember = (value: ModelList) => (cache().set(id, { at: now, ttl: value.source === 'live' ? TTL_MS : FAIL_TTL_MS, value }), value);
    try {
      const res = await (opts.fetch ?? fetch)(req.url, { headers: req.headers as Record<string, string>, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return remember(fallback(provider, `The provider answered ${res.status}; showing the built-in list.`));
      const models = [...new Set(req.read((await res.json()) as Record<string, unknown>))].sort();
      if (!models.length) return remember(fallback(provider, 'The provider returned no models; showing the built-in list.'));
      return remember({ models, source: 'live' });
    } catch (e) {
      // Only the error's name: a fetch error message can echo the URL, which carries the key.
      return remember(fallback(provider, `Could not reach the provider (${e instanceof Error ? e.name : 'error'}); showing the built-in list.`));
    }
  } catch {
    return fallback(provider, 'Could not read the model list; showing the built-in list.');
  }
}
