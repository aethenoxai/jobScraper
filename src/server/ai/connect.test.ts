import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createLogger } from '../logging';
import { createSettings } from '../settings';
import { testProvider } from './connect';
import { AI_SETTINGS_KEY, MODEL_CHOICES } from './settings';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const answering = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
      warnings: [],
    }),
  });
const failing = (message: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(message);
    },
  });

const GEMINI = { provider: 'google', model: 'gemini-3-flash-preview' };

function setup(opts: { env?: Record<string, string | undefined>; model?: () => MockLanguageModelV4; inDocker?: boolean; tasks?: Record<string, unknown> } = {}) {
  const settings = createSettings(t.db);
  if (opts.tasks) settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: opts.tasks });
  const env: Record<string, string | undefined> = opts.env ?? {};
  const written: Array<[string, string]> = [];
  const used: Array<{ provider: string; model: string; key?: string }> = [];
  const deps = {
    db: t.db,
    settings,
    log,
    env: () => env,
    inDocker: opts.inDocker ?? false,
    writeKey: (key: string, value: string) => {
      written.push([key, value]);
      env[key] = value;
    },
    modelFactory: (provider: string, model: string, _s: unknown, e: Record<string, string | undefined>) => {
      used.push({ provider, model, key: e.OPENAI_API_KEY ?? e.ANTHROPIC_API_KEY ?? e.GOOGLE_GENERATIVE_AI_API_KEY });
      return (opts.model ?? (() => answering('{"ok":true}')))();
    },
  };
  return { deps, settings, env, written, used, stored: () => settings.get(AI_SETTINGS_KEY, z.unknown(), undefined) };
}

describe('testProvider: tries one provider and model', () => {
  it('tests one provider without changing where tasks are routed', async () => {
    const s = setup({ env: { GOOGLE_GENERATIVE_AI_API_KEY: 'g-key-123456' }, tasks: { 'jd-analysis': { provider: 'openai', model: 'gpt-5-mini' } } });
    const before = JSON.stringify(s.stored());
    expect(await testProvider(s.deps, GEMINI)).toMatchObject({ ok: true, message: expect.stringMatching(/connected.*gemini-3-flash-preview/i) });
    expect(s.used).toEqual([{ provider: 'google', model: 'gemini-3-flash-preview', key: 'g-key-123456' }]);
    expect(JSON.stringify(s.stored())).toBe(before);
  });

  it('saves a pasted key to .env, never to the settings', async () => {
    const s = setup();
    const r = await testProvider(s.deps, { provider: 'openai', model: 'gpt-5-mini', apiKey: ' sk-pasted-123456 ' });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/connected/i) });
    expect(s.written).toEqual([['OPENAI_API_KEY', 'sk-pasted-123456']]);
    expect(s.used).toEqual([{ provider: 'openai', model: 'gpt-5-mini', key: 'sk-pasted-123456' }]);
    expect(s.stored()).toBeUndefined();
  });

  it('a failed test says why, without the key', async () => {
    const s = setup({ model: () => failing('401 Incorrect API key provided: sk-pasted-123456') });
    const r = await testProvider(s.deps, { provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-pasted-123456' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(r.message).not.toContain('sk-pasted-123456');
  });

  it('asks for the key when none is pasted or saved, and uses a saved one when the field is left empty', async () => {
    expect(await testProvider(setup().deps, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })).toEqual({ ok: false, message: expect.stringMatching(/paste your anthropic api key/i) });
    const saved = setup({ env: { ANTHROPIC_API_KEY: 'sk-ant-saved-123' } });
    expect(await testProvider(saved.deps, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })).toMatchObject({ ok: true });
    expect(saved.written).toEqual([]);
    expect(saved.used[0]).toMatchObject({ key: 'sk-ant-saved-123' });
  });

  it('does not save a key the shell already sets (that one would win) and says so', async () => {
    const s = setup({ env: { OPENAI_API_KEY: 'sk-shell-123456' } });
    const r = await testProvider({ ...s.deps, shellDefines: (k: string) => k === 'OPENAI_API_KEY' }, { provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-other-123456' });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/set in the shell/i) });
    expect(s.written).toEqual([]);
  });

  it('in Docker explains where the key goes instead of writing it inside the container', async () => {
    const s = setup({ inDocker: true });
    const r = await testProvider(s.deps, { provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-pasted-123456' });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/docker compose up -d/) });
    expect(s.written).toEqual([]);
  });

  it('needs a real provider, a model, and an address for local servers', async () => {
    const s = setup();
    expect((await testProvider(s.deps, { provider: 'none', model: 'm' })).ok).toBe(false);
    expect((await testProvider(s.deps, { provider: 'banana', model: 'm' })).ok).toBe(false);
    expect(await testProvider(s.deps, { provider: 'openai-compatible', model: 'm' })).toEqual({ ok: false, message: expect.stringMatching(/base url|address/i) });
    expect(await testProvider(s.deps, { provider: 'ollama', model: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/choose a model/i) });
    expect(await testProvider(s.deps, { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434/api' })).toMatchObject({ ok: true });
  });

  it('offers known models for the hosted providers', () => {
    for (const p of ['openai', 'anthropic', 'google'] as const) expect(MODEL_CHOICES[p].length).toBeGreaterThan(0);
  });

  it('a plan sign-in must exist before ChatGPT can be tested, and needs no key', async () => {
    const s = setup();
    expect(await testProvider(s.deps, { provider: 'chatgpt', model: 'gpt-5-mini' })).toEqual({ ok: false, message: expect.stringMatching(/sign in with chatgpt/i) });
    expect(s.written).toEqual([]);
  });
});
