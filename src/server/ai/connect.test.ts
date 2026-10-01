import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createLogger } from '../logging';
import { readOnboarding } from '../onboarding';
import { createSettings } from '../settings';
import { connectAi } from './connect';
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, DEFAULT_MODELS, MODEL_CHOICES } from './settings';

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

function setup(opts: { env?: Record<string, string | undefined>; model?: () => MockLanguageModelV4; inDocker?: boolean } = {}) {
  const settings = createSettings(t.db);
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
      used.push({ provider, model, key: e.OPENAI_API_KEY ?? e.ANTHROPIC_API_KEY });
      return (opts.model ?? (() => answering('{"ok":true}')))();
    },
  };
  return { deps, settings, env, written, used, saved: () => settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS) };
}

describe('connectAi: the setup step that chooses and tests an AI model', () => {
  it('saves a pasted key to .env, tests the chosen models and marks the step done', async () => {
    const s = setup();
    const r = await connectAi(s.deps, { provider: 'openai', apiKey: ' sk-pasted-123456 ', fastModel: 'gpt-5-mini', qualityModel: 'gpt-5' });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/connected/i) });
    expect(s.written).toEqual([['OPENAI_API_KEY', 'sk-pasted-123456']]);
    expect(s.used).toEqual([{ provider: 'openai', model: 'gpt-5-mini', key: 'sk-pasted-123456' }]);
    expect(s.saved()).toMatchObject({ provider: 'openai', fastModel: 'gpt-5-mini', qualityModel: 'gpt-5', dailyBudgetUsd: 2 });
    expect(readOnboarding(s.settings)?.aiVerifiedAt).toEqual(expect.any(Number));
  });

  it('a failed test says why (without the key) and does not mark the step done or save the choice', async () => {
    const s = setup({ model: () => failing('401 Incorrect API key provided: sk-pasted-123456') });
    const r = await connectAi(s.deps, { provider: 'openai', apiKey: 'sk-pasted-123456' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(r.message).not.toContain('sk-pasted-123456');
    expect(readOnboarding(s.settings)).toBeNull();
    expect(s.saved().provider).toBe('none');
  });

  it('asks for the key when none is pasted or saved, and uses a saved one when the field is left empty', async () => {
    const empty = setup();
    expect(await connectAi(empty.deps, { provider: 'anthropic' })).toEqual({ ok: false, message: expect.stringMatching(/paste your anthropic api key/i) });
    const saved = setup({ env: { ANTHROPIC_API_KEY: 'sk-ant-saved-123' } });
    expect(await connectAi(saved.deps, { provider: 'anthropic' })).toMatchObject({ ok: true });
    expect(saved.written).toEqual([]);
    expect(saved.used[0]).toMatchObject({ key: 'sk-ant-saved-123', model: DEFAULT_MODELS.anthropic.fast });
  });

  it('does not save a key the shell already sets (that one would win) and says so', async () => {
    const s = setup({ env: {} });
    s.env.OPENAI_API_KEY = 'sk-shell-123456';
    const r = await connectAi({ ...s.deps, shellDefines: (k: string) => k === 'OPENAI_API_KEY' }, { provider: 'openai', apiKey: 'sk-other-123456' });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/set in the shell/i) });
    expect(s.written).toEqual([]);
  });

  it('in Docker explains where the key goes instead of writing it inside the container', async () => {
    const s = setup({ inDocker: true });
    const r = await connectAi(s.deps, { provider: 'openai', apiKey: 'sk-pasted-123456' });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/docker compose up -d/) });
    expect(s.written).toEqual([]);
  });

  it('needs a real provider, and an address for local servers', async () => {
    const s = setup();
    expect((await connectAi(s.deps, { provider: 'none' })).ok).toBe(false);
    expect((await connectAi(s.deps, { provider: 'banana' })).ok).toBe(false);
    expect(await connectAi(s.deps, { provider: 'openai-compatible', fastModel: 'm', qualityModel: 'm' })).toEqual({ ok: false, message: expect.stringMatching(/base url|address/i) });
    expect(await connectAi(s.deps, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/api' })).toMatchObject({ ok: true });
  });

  it('offers known models for the hosted providers, with the defaults among them', () => {
    for (const p of ['openai', 'anthropic', 'google'] as const) {
      expect(MODEL_CHOICES[p]).toContain(DEFAULT_MODELS[p].fast);
      expect(MODEL_CHOICES[p]).toContain(DEFAULT_MODELS[p].quality);
    }
  });
});
