import { beforeEach, describe, expect, it } from 'vitest';
import { listModels } from './models';
import { MODEL_CHOICES } from './settings';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__jobScraperModelCache;
});

describe('listModels', () => {
  it('lists Google text models only, and caches for ten minutes', async () => {
    let t = 0;
    const f = fake(() => json({ models: [
      { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    ] }));
    const opts = { env: { GEMINI_API_KEY: 'k' }, fetch: f.impl, now: () => t };
    expect(await listModels('google', opts)).toEqual({ models: ['gemini-3-flash-preview'], source: 'live' });
    expect(f.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=k&pageSize=1000');
    t = 9 * 60_000;
    await listModels('google', opts);
    expect(f.calls).toHaveLength(1);
    t = 10 * 60_000 + 1;
    await listModels('google', opts);
    expect(f.calls).toHaveLength(2);
  });

  it('reads OpenAI, Anthropic, Ollama and compatible servers', async () => {
    const f = fake((url) =>
      url.includes('/api/tags') ? json({ models: [{ name: 'llama3.1:8b' }] }) : json({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    expect((await listModels('openai', { env: { OPENAI_API_KEY: 'k' }, fetch: f.impl })).models).toEqual(['m1', 'm2']);
    expect(new Headers(f.calls[0].init.headers).get('authorization')).toBe('Bearer k');
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/models');
    await listModels('anthropic', { env: { ANTHROPIC_API_KEY: 'k' }, fetch: f.impl });
    const h = new Headers(f.calls[1].init.headers);
    expect(f.calls[1].url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(h.get('x-api-key')).toBe('k');
    expect(h.get('anthropic-version')).toBe('2023-06-01');
    expect(await listModels('ollama', { env: {}, baseUrl: 'http://localhost:11434', fetch: f.impl })).toEqual({ models: ['llama3.1:8b'], source: 'live' });
    expect(f.calls[2].url).toBe('http://localhost:11434/api/tags');
    await listModels('openai-compatible', { env: {}, baseUrl: 'http://srv:8000/v1/', fetch: f.impl });
    expect(f.calls[3].url).toBe('http://srv:8000/v1/models');
  });

  it('falls back to the built-in list when the endpoint fails, and says why', async () => {
    const f = fake(() => { throw new TypeError('network down'); });
    const r = await listModels('anthropic', { env: { ANTHROPIC_API_KEY: 'k' }, fetch: f.impl });
    expect(r.source).toBe('fallback');
    expect(r.models).toEqual(MODEL_CHOICES.anthropic);
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain('k"');
  });

  it('falls back on non-200, malformed bodies and empty lists, without caching them', async () => {
    for (const res of [() => json({}, 401), () => new Response('nope'), () => json({ data: [] }), () => json({ data: 5 })]) {
      delete (globalThis as Record<string, unknown>).__jobScraperModelCache;
      const r = await listModels('openai', { env: { OPENAI_API_KEY: 'k' }, fetch: fake(res).impl });
      expect(r).toMatchObject({ source: 'fallback', models: MODEL_CHOICES.openai });
      expect(r.error).toBeTruthy();
    }
    const f = fake(() => json({ data: [{ id: 'x' }] }));
    expect((await listModels('openai', { env: { OPENAI_API_KEY: 'k' }, fetch: f.impl })).source).toBe('live');
  });

  it('does not call the network without a key, and never throws', async () => {
    const f = fake(() => { throw new Error('x'); });
    for (const p of ['openai', 'anthropic', 'google'] as const) {
      expect(await listModels(p, { env: {}, fetch: f.impl })).toMatchObject({ source: 'fallback', models: MODEL_CHOICES[p] });
    }
    expect(f.calls).toEqual([]);
  });

  it('returns the static list for the plan providers, with no call', async () => {
    const f = fake(() => json({}));
    expect(await listModels('claude-code', { env: {}, fetch: f.impl })).toEqual({ models: MODEL_CHOICES['claude-code'], source: 'fallback' });
    expect((await listModels('chatgpt', { env: {}, fetch: f.impl })).models).toEqual(MODEL_CHOICES.chatgpt);
    expect((await listModels('none', { env: {}, fetch: f.impl })).models).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});
