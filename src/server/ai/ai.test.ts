import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { aiUsage } from '../db/schema';
import { createLogger } from '../logging';
import { createSettings } from '../settings';
import { AiBudgetExceededError, AiNotConfiguredError, createAi, estimateCostUsd } from './index';
import { AI_SETTINGS_KEY, DEFAULT_MODELS } from './settings';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function mockModel(text: string, calls: string[] = []) {
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      calls.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 500, text: 500, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function setup(opts: { provider?: string; env?: Record<string, string>; budget?: number | null; text?: string; calls?: string[] } = {}) {
  const settings = createSettings(t.db);
  settings.set(AI_SETTINGS_KEY, { provider: opts.provider ?? 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: opts.budget ?? null });
  const seen: Array<{ provider: string; model: string }> = [];
  const ai = createAi({
    db: t.db,
    settings,
    log,
    env: opts.env ?? { OPENAI_API_KEY: 'sk-test-123456' },
    modelFactory: (provider, model) => {
      seen.push({ provider, model });
      return mockModel(opts.text ?? '{"name":"Asha"}', opts.calls);
    },
  });
  return { ai, seen, settings };
}

describe('ai', () => {
  it('is not configured when the provider is none or its key is missing', () => {
    expect(setup({ provider: 'none' }).ai.status()).toMatchObject({ configured: false });
    const noKey = setup({ env: {} }).ai.status();
    expect(noKey).toMatchObject({ configured: false, keyEnvVar: 'OPENAI_API_KEY', keyPresent: false });
    expect(noKey.reason).toContain('OPENAI_API_KEY');
  });

  it('notices a key added after start (read from the environment on every check)', async () => {
    const env: Record<string, string | undefined> = {};
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: null });
    const keys: Array<string | undefined> = [];
    const ai = createAi({
      db: t.db,
      settings,
      log,
      env: () => env,
      modelFactory: (_p, _m, _s, e) => {
        keys.push(e.OPENAI_API_KEY);
        return mockModel('{"name":"Asha"}');
      },
    });
    expect(ai.status().configured).toBe(false);
    env.OPENAI_API_KEY = 'sk-added-later-123';
    expect(ai.status().configured).toBe(true);
    await ai.generateObject({ role: 'fast', task: 't', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' });
    expect(keys).toEqual(['sk-added-later-123']);
  });

  it('ollama needs no key', () => {
    expect(setup({ provider: 'ollama', env: {} }).ai.status().configured).toBe(true);
  });

  it('an OpenAI-compatible server needs only its address (many local servers take no key)', () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { provider: 'openai-compatible', fastModel: 'local-model', qualityModel: 'local-model', baseUrl: 'http://127.0.0.1:8080/v1', dailyBudgetUsd: null });
    expect(createAi({ db: t.db, settings, log, env: {} }).status()).toMatchObject({ configured: true });
  });

  it('generates a validated object with the role default model and records usage', async () => {
    const calls: string[] = [];
    const { ai, seen } = setup({ calls });
    const out = await ai.generateObject({ role: 'fast', task: 'test', schema: z.object({ name: z.string() }), system: 'sys', prompt: 'hello' });
    expect(out).toEqual({ name: 'Asha' });
    expect(seen[0]).toEqual({ provider: 'openai', model: DEFAULT_MODELS.openai.fast });
    expect(calls[0]).toContain('hello');
    const [row] = t.db.select().from(aiUsage).all();
    expect(row).toMatchObject({ task: 'test', role: 'fast', provider: 'openai', inputTokens: 1000, outputTokens: 500, ok: true });
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it('rejects output that does not match the schema and records the failure', async () => {
    const { ai } = setup({ text: '{"wrong":1}' });
    await expect(ai.generateObject({ role: 'fast', task: 'test', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' })).rejects.toThrow();
    expect(t.db.select().from(aiUsage).all()[0].ok).toBe(false);
  });

  it('refuses calls when not configured', async () => {
    const { ai } = setup({ env: {} });
    await expect(ai.generateObject({ role: 'fast', task: 't', schema: z.object({}), system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it('enforces the daily budget', async () => {
    const { ai } = setup({ budget: 0.000001 });
    await ai.generateObject({ role: 'fast', task: 't', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' });
    await expect(ai.generateObject({ role: 'fast', task: 't', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(ai.status().spentTodayUsd).toBeGreaterThan(0);
  });

  it('calls running side by side cannot together overspend the budget (M12 deferred minor)', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: 'gpt-5-mini', qualityModel: null, baseUrl: null, dailyBudgetUsd: 0.001 });
    const slow = new MockLanguageModelV4({
      doGenerate: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: [{ type: 'text', text: '{"name":"x"}' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 500, text: 500, reasoning: undefined } }, warnings: [] };
      },
    });
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => slow });
    const call = () => ai.generateObject({ role: 'fast', task: 't', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' });
    const results = await Promise.allSettled([call(), call(), call()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof AiBudgetExceededError)).toHaveLength(2);
    // The finished call is recorded with its real usage, not the reservation.
    expect(t.db.select().from(aiUsage).all()).toEqual([expect.objectContaining({ ok: true, inputTokens: 1000, outputTokens: 500 })]);
  });

  it('calls the budget hook when the daily budget stops a call', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: 0 });
    const hits: number[] = [];
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => mockModel('{}'), onBudgetExceeded: (b) => hits.push(b) });
    await expect(ai.generateObject({ role: 'fast', task: 't', schema: z.object({}), system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(hits).toEqual([0]);
  });

  it('estimates zero cost for local models', () => {
    expect(estimateCostUsd('ollama', 'llama3.1', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd('openai', 'unknown-model', 1_000_000, 0)).toBeGreaterThan(0);
  });

  describe('Claude through the user’s own Claude Code', () => {
    function claude(opts: { bin?: string | null; limit?: number | null } = {}) {
      const settings = createSettings(t.db);
      settings.set(AI_SETTINGS_KEY, { provider: 'claude-code', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: opts.limit ?? null });
      const calls: Array<{ bin: string; model: string; prompt: string }> = [];
      const ai = createAi({
        db: t.db,
        settings,
        log,
        env: {},
        claudeCodeBin: () => (opts.bin === undefined ? '/usr/local/bin/claude' : opts.bin),
        runClaudeCode: async (req) => {
          calls.push({ bin: req.bin, model: req.model, prompt: req.prompt });
          return { object: req.schema.parse({ name: 'Asha' }), inputTokens: 100, outputTokens: 10 };
        },
      });
      return { ai, calls };
    }
    const ask = (ai: ReturnType<typeof createAi>, role: 'fast' | 'quality' = 'fast') => ai.generateObject({ role, task: 't', schema: z.object({ name: z.string() }), system: 's', prompt: 'p' });

    it('is ready when claude is installed (no key), and says how to get it when it is not', () => {
      expect(claude().ai.status()).toMatchObject({ configured: true, keyEnvVar: null, models: { fast: 'haiku', quality: 'sonnet' } });
      expect(claude({ bin: null }).ai.status()).toMatchObject({ configured: false, reason: expect.stringMatching(/install/i) });
    });

    it('answers through claude with the model of each role, and costs nothing extra', async () => {
      const { ai, calls } = claude();
      expect(await ask(ai)).toEqual({ name: 'Asha' });
      await ask(ai, 'quality');
      expect(calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
      const rows = t.db.select().from(aiUsage).all();
      expect(rows.map((r) => [r.provider, r.costUsd, r.ok])).toEqual([['claude-code', 0, true], ['claude-code', 0, true]]);
      expect(ai.status().spentTodayUsd).toBe(0);
    });

    it('stops after the daily number of calls, so matching cannot use up the plan', async () => {
      const { ai, calls } = claude({ limit: 2 });
      await ask(ai);
      await ask(ai);
      await expect(ask(ai)).rejects.toBeInstanceOf(AiBudgetExceededError);
      await expect(ask(ai)).rejects.toThrow(/2 AI calls/);
      expect(calls).toHaveLength(2);
    });
  });
});
