import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { aiUsage } from '../db/schema';
import { createLogger } from '../logging';
import { createSettings } from '../settings';
import { AiBudgetExceededError, AiNotConfiguredError, createAi, defaultModelFactory, estimateCostUsd, type Ai } from './index';
import { AI_SETTINGS_KEY, DEFAULT_AI_SETTINGS, type AiRoute, type AiSettings, type AiTask } from './settings';

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

const ALL_OFFLINE = DEFAULT_AI_SETTINGS.tasks as Record<AiTask, AiRoute>;
/** Every task on one route (the old single-provider setup), unless overridden. */
const allOn = (route: AiRoute, tasks: Partial<Record<AiTask, AiRoute>> = {}) => Object.fromEntries(Object.keys(ALL_OFFLINE).map((k) => [k, tasks[k as AiTask] ?? route])) as Record<AiTask, AiRoute>;
const obj = z.object({ name: z.string() });
const ask = (ai: Ai, task: AiTask = 'jd-analysis') => ai.generateObject({ task, schema: obj, system: 's', prompt: 'p' });

function routed(tasks: Partial<Record<AiTask, AiRoute>>, env: Record<string, string> = { OPENAI_API_KEY: 'sk-test-123456' }, providers: AiSettings['providers'] = {}, calls: string[] = []) {
  const settings = createSettings(t.db);
  settings.set(AI_SETTINGS_KEY, { providers, tasks: { ...DEFAULT_AI_SETTINGS.tasks, ...tasks } });
  const seen: Array<{ provider: string; model: string }> = [];
  const ai = createAi({ db: t.db, settings, log, env, modelFactory: (provider, model) => { seen.push({ provider, model }); return mockModel('{"name":"Asha"}', calls); } });
  return { ai, seen, settings };
}

const OPENAI_MINI: AiRoute = { provider: 'openai', model: 'gpt-5-mini' };

describe('ai', () => {
  it('sends each task to its own provider and model', async () => {
    const s = routed({ 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' }, 'jd-analysis': OPENAI_MINI }, { OPENAI_API_KEY: 'sk-test-123456', GEMINI_API_KEY: 'k' });
    await ask(s.ai, 'cv-extract');
    await ask(s.ai, 'jd-analysis');
    expect(s.seen).toEqual([{ provider: 'google', model: 'gemini-3-flash-preview' }, { provider: 'openai', model: 'gpt-5-mini' }]);
    expect(t.db.select().from(aiUsage).all().map((r) => [r.task, r.provider, r.model])).toEqual([
      ['cv-extract', 'google', 'gemini-3-flash-preview'],
      ['jd-analysis', 'openai', 'gpt-5-mini'],
    ]);
  });

  it('reports status per task, and names the missing key', () => {
    const s = routed({ 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' } }, {});
    expect(s.ai.taskStatus('cv-extract')).toMatchObject({ configured: false, provider: 'google', model: 'gemini-3-flash-preview' });
    expect(s.ai.taskStatus('cv-extract').reason).toMatch(/GEMINI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY/);
    expect(s.ai.taskStatus('match-evaluate')).toMatchObject({ provider: 'none', configured: false });
  });

  it('refuses a task whose route is unusable without touching the others', async () => {
    const s = routed({ 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' }, 'jd-analysis': OPENAI_MINI });
    await expect(ask(s.ai, 'cv-extract')).rejects.toBeInstanceOf(AiNotConfiguredError);
    await expect(ask(s.ai, 'jd-analysis')).resolves.toEqual({ name: 'Asha' });
  });

  it('names the task, provider and model when the model is rejected', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: { ...DEFAULT_AI_SETTINGS.tasks, 'jd-analysis': { provider: 'openai', model: 'gpt-retired' } } });
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => new MockLanguageModelV4({ doGenerate: async () => { throw new Error('model_not_found'); } }) });
    await expect(ask(ai)).rejects.toThrow(/jd-analysis[\s\S]*openai[\s\S]*gpt-retired[\s\S]*model_not_found/);
  });

  it('a task with no stored route runs offline; an old single-provider row still works', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: null, dailyCallLimit: 300 });
    const seen: string[] = [];
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: (_p, m) => { seen.push(m); return mockModel('{"name":"Asha"}'); } });
    await ask(ai, 'jd-analysis');
    await ask(ai, 'cv-tailor');
    expect(seen).toEqual(['gpt-5-mini', 'gpt-5']);
    const partial = createSettings(t.db);
    partial.set(AI_SETTINGS_KEY, { providers: {}, tasks: {} });
    expect(createAi({ db: t.db, settings: partial, log, env: {} }).taskStatus('inbox-classify')).toMatchObject({ provider: 'none', configured: false });
  });

  it('notices a key added after start (read from the environment on every check)', async () => {
    const env: Record<string, string | undefined> = {};
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: allOn(OPENAI_MINI) });
    const keys: Array<string | undefined> = [];
    const ai = createAi({ db: t.db, settings, log, env: () => env, modelFactory: (_p, _m, _s, e) => { keys.push(e.OPENAI_API_KEY); return mockModel('{"name":"Asha"}'); } });
    expect(ai.taskStatus('jd-analysis').configured).toBe(false);
    env.OPENAI_API_KEY = 'sk-added-later-123';
    expect(ai.taskStatus('jd-analysis').configured).toBe(true);
    await ask(ai);
    expect(keys).toEqual(['sk-added-later-123']);
  });

  it('sends the document itself to providers that read files, and only the text to the others', async () => {
    const pdf = { data: new Uint8Array([37, 80, 68, 70]), mediaType: 'application/pdf' };
    const readCv = (ai: Ai) => ai.generateObject({ task: 'cv-extract', schema: obj, system: 's', prompt: 'CV text', file: pdf });
    const withFile: string[] = [];
    await readCv(routed({ 'cv-extract': OPENAI_MINI }, undefined, {}, withFile).ai);
    expect(withFile[0]).toContain('"type":"file"');
    expect(withFile[0]).toContain('application/pdf');
    expect(withFile[0]).toContain('CV text');
    const textOnly: string[] = [];
    await readCv(routed({ 'cv-extract': { provider: 'openai-compatible', model: 'm' } }, {}, { 'openai-compatible': { baseUrl: 'http://127.0.0.1:1/v1', dailyBudgetUsd: null, dailyCallLimit: null } }, textOnly).ai);
    expect(textOnly[0]).not.toContain('"type":"file"');
    expect(textOnly[0]).toContain('CV text');
  });

  it('reads CVs with Gemini 3 Flash and everything else with the plan, and accepts either Google key name', async () => {
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
      const claudeCalls: string[] = [];
      const settings = createSettings(t.db);
      settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: allOn({ provider: 'claude-code', model: 'haiku' }, { 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' } }) });
      const seen: string[] = [];
      const ai = createAi({
        db: t.db, settings, log, env: { [key]: 'AIza-test-123456' },
        modelFactory: (p, m) => { seen.push(`${p}:${m}`); return mockModel('{"name":"Asha"}'); },
        claudeCodeBin: () => '/usr/local/bin/claude',
        runClaudeCode: async (req) => { claudeCalls.push(req.model); return { object: req.schema.parse({ name: 'Asha' }), inputTokens: 100, outputTokens: 10 }; },
      });
      await ask(ai, 'cv-extract');
      await ask(ai, 'match-evaluate');
      expect(seen).toEqual(['google:gemini-3-flash-preview']);
      expect(claudeCalls).toEqual(['haiku']);
    }
    // Gemini is paid per token, so the daily budget counts it (the plan providers cost 0).
    expect(t.db.select().from(aiUsage).all().find((r) => r.provider === 'google')!.costUsd).toBeGreaterThan(0);
  });

  it('prices Gemini by its own rates (“gemini” contains “mini”)', () => {
    expect(estimateCostUsd('google', 'gemini-3-flash-preview', 1_000_000, 1_000_000)).toBeCloseTo(3.5);
    expect(estimateCostUsd('google', 'gemini-2.5-pro', 1_000_000, 0)).toBeCloseTo(1.25);
  });

  it('a provider never configured gets the schema defaults, and "none" has no key', () => {
    const { ai } = routed({});
    expect(ai.providerStatus('google')).toMatchObject({ dailyBudgetUsd: 2, dailyCallLimit: 300, baseUrl: null });
    expect(ai.providerStatus('none')).toMatchObject({ keyPresent: false, configured: false });
  });

  it('ollama needs no key', () => {
    expect(routed({ 'jd-analysis': { provider: 'ollama', model: 'llama3.1' } }, {}).ai.taskStatus('jd-analysis').configured).toBe(true);
  });

  it('an OpenAI-compatible server needs only its address (many local servers take no key)', () => {
    const route: AiRoute = { provider: 'openai-compatible', model: 'local-model' };
    expect(routed({ 'jd-analysis': route }, {}, { 'openai-compatible': { baseUrl: 'http://127.0.0.1:8080/v1', dailyBudgetUsd: null, dailyCallLimit: null } }).ai.taskStatus('jd-analysis').configured).toBe(true);
    expect(routed({ 'jd-analysis': route }, {}).ai.taskStatus('jd-analysis').reason).toMatch(/base URL/i);
  });

  it('asks for a model when the route has none', () => {
    expect(routed({ 'jd-analysis': { provider: 'openai', model: null } }).ai.taskStatus('jd-analysis').reason).toMatch(/model/i);
  });

  it('generates a validated object and records usage', async () => {
    const calls: string[] = [];
    const { ai } = routed({ 'jd-analysis': OPENAI_MINI }, undefined, {}, calls);
    expect(await ai.generateObject({ task: 'jd-analysis', schema: obj, system: 'sys', prompt: 'hello' })).toEqual({ name: 'Asha' });
    expect(calls[0]).toContain('hello');
    const [row] = t.db.select().from(aiUsage).all();
    expect(row).toMatchObject({ task: 'jd-analysis', provider: 'openai', inputTokens: 1000, outputTokens: 500, ok: true });
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it('rejects output that does not match the schema and records the failure', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: allOn(OPENAI_MINI) });
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => mockModel('{"wrong":1}') });
    await expect(ask(ai)).rejects.toThrow();
    expect(t.db.select().from(aiUsage).all()[0].ok).toBe(false);
  });

  it('refuses calls when not configured', async () => {
    await expect(ask(routed({ 'jd-analysis': OPENAI_MINI }, {}).ai)).rejects.toBeInstanceOf(AiNotConfiguredError);
    await expect(ask(routed({}).ai)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it('enforces the daily budget', async () => {
    const { ai } = routed({ 'jd-analysis': OPENAI_MINI }, undefined, { openai: { baseUrl: null, dailyBudgetUsd: 0.000001, dailyCallLimit: 300 } });
    await ask(ai);
    await expect(ask(ai)).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(ai.providerStatus('openai').spentTodayUsd).toBeGreaterThan(0);
    expect(ai.providerStatus('openai').callsToday).toBe(1);
    expect(ai.providerStatus('google').callsToday).toBe(0);
  });

  it('stops only the tasks routed to the provider that ran out', async () => {
    const s = routed(
      { 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' }, 'jd-analysis': OPENAI_MINI },
      { OPENAI_API_KEY: 'sk-test-123456', GEMINI_API_KEY: 'k' },
      { google: { baseUrl: null, dailyBudgetUsd: 0, dailyCallLimit: null }, openai: { baseUrl: null, dailyBudgetUsd: 5, dailyCallLimit: null } },
    );
    await expect(ask(s.ai, 'cv-extract')).rejects.toBeInstanceOf(AiBudgetExceededError);
    await expect(ask(s.ai, 'jd-analysis')).resolves.toEqual({ name: 'Asha' });
  });

  it('compares a provider’s own spend with its own budget, and the message agrees with the settings page', async () => {
    const s = routed(
      { 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' }, 'jd-analysis': OPENAI_MINI },
      { OPENAI_API_KEY: 'sk-test-123456', GEMINI_API_KEY: 'k' },
      { openai: { baseUrl: null, dailyBudgetUsd: 50, dailyCallLimit: null } },
    );
    t.db.insert(aiUsage).values({ task: 'jd-analysis', role: '', provider: 'openai', model: 'gpt-5-mini', inputTokens: 1, outputTokens: 1, costUsd: 3, ok: true, createdAt: new Date() }).run();
    await expect(ask(s.ai, 'cv-extract')).resolves.toEqual({ name: 'Asha' });
    expect(s.ai.providerStatus('google').spentTodayUsd).toBeGreaterThan(0);
    // Now google really has spent more than its default $2: the message names google and its own numbers.
    t.db.insert(aiUsage).values({ task: 'cv-extract', role: '', provider: 'google', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 2.5, ok: true, createdAt: new Date() }).run();
    await expect(ask(s.ai, 'cv-extract')).rejects.toThrow(/google.*\$2\.00/);
    await expect(ask(s.ai, 'jd-analysis')).resolves.toEqual({ name: 'Asha' });
  });

  it('counts a plan provider in calls and a keyed provider in dollars, separately', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, {
      providers: { 'claude-code': { baseUrl: null, dailyBudgetUsd: null, dailyCallLimit: 1 }, google: { baseUrl: null, dailyBudgetUsd: 5, dailyCallLimit: null } },
      tasks: { ...DEFAULT_AI_SETTINGS.tasks, 'jd-analysis': { provider: 'claude-code', model: 'haiku' }, 'cv-extract': { provider: 'google', model: 'gemini-3-flash-preview' } },
    });
    const ai = createAi({
      db: t.db, settings, log, env: { GEMINI_API_KEY: 'k' },
      claudeCodeBin: () => '/usr/local/bin/claude',
      runClaudeCode: async (req) => ({ object: req.schema.parse({ name: 'Asha' }), inputTokens: 1, outputTokens: 1 }),
      modelFactory: () => mockModel('{"name":"Asha"}'),
    });
    await ask(ai, 'jd-analysis');
    await expect(ask(ai, 'jd-analysis')).rejects.toThrow(/claude-code.*1 AI calls/);
    await expect(ask(ai, 'cv-extract')).resolves.toEqual({ name: 'Asha' });
  });

  it('one plan provider’s call limit does not stop the other plan provider', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, {
      providers: { 'claude-code': { baseUrl: null, dailyBudgetUsd: null, dailyCallLimit: 2 }, chatgpt: { baseUrl: null, dailyBudgetUsd: null, dailyCallLimit: 2 } },
      tasks: { ...DEFAULT_AI_SETTINGS.tasks, 'jd-analysis': { provider: 'chatgpt', model: 'gpt-5-mini' } },
    });
    settings.set('ai.chatgpt', { clientId: 'oaiapp_1', email: 'a@example.com', subject: 's', idToken: 'x.y.z', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000, scope: 'chatgpt.tokens.use.direct', connectedAt: 1, needsReconnect: false });
    for (let i = 0; i < 2; i++) t.db.insert(aiUsage).values({ task: 'jd-analysis', role: '', provider: 'claude-code', model: 'haiku', inputTokens: 1, outputTokens: 1, costUsd: 0, ok: true, createdAt: new Date() }).run();
    const ai = createAi({ db: t.db, settings, log, env: {}, chatgptAccessToken: async () => 'at', modelFactory: () => mockModel('{"name":"Asha"}') });
    expect(ai.providerStatus('chatgpt').callsToday).toBe(0);
    // Whatever the model does next, it must not be the call limit that stops ChatGPT.
    await ask(ai).catch((e) => expect(e).not.toBeInstanceOf(AiBudgetExceededError));
    expect(t.db.select().from(aiUsage).all().filter((r) => r.provider === 'chatgpt')).toHaveLength(1);
  });

  it('calls running side by side cannot together overspend the budget (M12 deferred minor)', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: { openai: { baseUrl: null, dailyBudgetUsd: 0.001, dailyCallLimit: 300 } }, tasks: allOn(OPENAI_MINI) });
    const slow = new MockLanguageModelV4({
      doGenerate: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: [{ type: 'text', text: '{"name":"x"}' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 500, text: 500, reasoning: undefined } }, warnings: [] };
      },
    });
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => slow });
    const results = await Promise.allSettled([ask(ai), ask(ai), ask(ai)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof AiBudgetExceededError)).toHaveLength(2);
    // The finished call is recorded with its real usage, not the reservation.
    expect(t.db.select().from(aiUsage).all()).toEqual([expect.objectContaining({ ok: true, inputTokens: 1000, outputTokens: 500 })]);
  });

  it('calls the budget hook when the daily budget stops a call', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: { openai: { baseUrl: null, dailyBudgetUsd: 0, dailyCallLimit: 300 } }, tasks: allOn(OPENAI_MINI) });
    const hits: number[] = [];
    const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' }, modelFactory: () => mockModel('{}'), onBudgetExceeded: (b) => hits.push(b) });
    await expect(ask(ai)).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(hits).toEqual([0]);
  });

  it('estimates zero cost for local models', () => {
    expect(estimateCostUsd('ollama', 'llama3.1', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd('openai', 'unknown-model', 1_000_000, 0)).toBeGreaterThan(0);
  });

  describe('Claude through the user’s own Claude Code', () => {
    function claude(opts: { bin?: string | null; limit?: number | null } = {}) {
      const settings = createSettings(t.db);
      settings.set(AI_SETTINGS_KEY, { providers: { 'claude-code': { baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: opts.limit ?? null } }, tasks: allOn({ provider: 'claude-code', model: 'haiku' }, { 'cv-tailor': { provider: 'claude-code', model: 'sonnet' } }) });
      const calls: Array<{ bin: string; model: string; prompt: string }> = [];
      const ai = createAi({
        db: t.db, settings, log, env: {},
        claudeCodeBin: () => (opts.bin === undefined ? '/usr/local/bin/claude' : opts.bin),
        runClaudeCode: async (req) => {
          calls.push({ bin: req.bin, model: req.model, prompt: req.prompt });
          return { object: req.schema.parse({ name: 'Asha' }), inputTokens: 100, outputTokens: 10 };
        },
      });
      return { ai, calls };
    }

    it('is ready when claude is installed (no key), and says how to get it when it is not', () => {
      expect(claude().ai.taskStatus('jd-analysis')).toMatchObject({ configured: true, model: 'haiku' });
      expect(claude().ai.providerStatus('claude-code')).toMatchObject({ configured: true, keyEnvVar: null });
      expect(claude({ bin: null }).ai.taskStatus('jd-analysis')).toMatchObject({ configured: false, reason: expect.stringMatching(/install/i) });
    });

    it('answers through claude with the model of each task, and costs nothing extra', async () => {
      const { ai, calls } = claude();
      expect(await ask(ai)).toEqual({ name: 'Asha' });
      await ask(ai, 'cv-tailor');
      expect(calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
      expect(t.db.select().from(aiUsage).all().map((r) => [r.provider, r.costUsd, r.ok])).toEqual([['claude-code', 0, true], ['claude-code', 0, true]]);
      expect(ai.providerStatus('claude-code').spentTodayUsd).toBe(0);
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

  describe('ChatGPT through the user’s plan (Sign in with ChatGPT)', () => {
    function chatgpt(opts: { signedIn?: boolean } = {}) {
      const settings = createSettings(t.db);
      settings.set(AI_SETTINGS_KEY, { providers: { chatgpt: { baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 } }, tasks: allOn({ provider: 'chatgpt', model: 'gpt-5-mini' }) });
      if (opts.signedIn !== false) settings.set('ai.chatgpt', { clientId: 'oaiapp_1', email: 'a@example.com', subject: 's', idToken: 'x.y.z', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000, scope: 'chatgpt.tokens.use.direct', connectedAt: 1, needsReconnect: false });
      const seen: Array<{ model: string; token?: string; options: unknown }> = [];
      const ai = createAi({
        db: t.db, settings, log, env: {},
        chatgptAccessToken: async () => 'at-fresh-123456',
        modelFactory: (provider, model, _s, env) => {
          const m = new MockLanguageModelV4({
            doStream: async (options) => {
              seen.push({ model, token: env.CHATGPT_ACCESS_TOKEN, options });
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    { type: 'text-start' as const, id: '1' },
                    { type: 'text-delta' as const, id: '1', delta: '{"name":' },
                    { type: 'text-delta' as const, id: '1', delta: '"Asha"}' },
                    { type: 'text-end' as const, id: '1' },
                    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: { inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 8, text: 8, reasoning: undefined } } },
                  ],
                }),
              };
            },
          });
          expect(provider).toBe('chatgpt');
          return m;
        },
      });
      return { ai, seen };
    }

    it('is ready once signed in; otherwise asks to sign in', () => {
      expect(chatgpt({ signedIn: false }).ai.taskStatus('jd-analysis')).toMatchObject({ configured: false, reason: expect.stringMatching(/sign in with chatgpt/i) });
      expect(chatgpt().ai.taskStatus('jd-analysis')).toMatchObject({ configured: true, model: 'gpt-5-mini' });
    });

    it('streams the answer with the access token, stores nothing at OpenAI, and sends the system text as instructions', async () => {
      const { ai, seen } = chatgpt();
      expect(await ai.generateObject({ task: 'jd-analysis', schema: obj, system: 'Be exact.', prompt: 'Who?' })).toEqual({ name: 'Asha' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ model: 'gpt-5-mini', token: 'at-fresh-123456' });
      const options = seen[0].options as { providerOptions?: { openai?: Record<string, unknown> }; prompt: Array<{ role: string }>; temperature?: number; maxOutputTokens?: number };
      expect(options.providerOptions?.openai).toMatchObject({ store: false, instructions: 'Be exact.', systemMessageMode: 'remove' });
      expect(options.temperature).toBeUndefined();
      expect(options.maxOutputTokens).toBeUndefined();
      expect(t.db.select().from(aiUsage).all().map((r) => [r.provider, r.costUsd, r.ok, r.inputTokens])).toEqual([['chatgpt', 0, true, 40]]);
    });
  });

  it('the ChatGPT token only ever goes to api.openai.com, even with OPENAI_BASE_URL set for something else', () => {
    const before = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1';
    try {
      const model = defaultModelFactory('chatgpt', 'gpt-5-mini', { baseUrl: null, dailyBudgetUsd: null, dailyCallLimit: 300 }, { CHATGPT_ACCESS_TOKEN: 't' }) as unknown as { config: { url: (o: { path: string; modelId: string }) => string } };
      expect(model.config.url({ path: '/responses', modelId: 'gpt-5-mini' })).toBe('https://api.openai.com/v1/responses');
    } finally {
      if (before === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = before;
    }
  });

  it('when the ChatGPT plan’s usage limit is reached, AI pauses like a used-up budget', async () => {
    const settings = createSettings(t.db);
    settings.set(AI_SETTINGS_KEY, { providers: {}, tasks: allOn({ provider: 'chatgpt', model: 'gpt-5-mini' }) });
    settings.set('ai.chatgpt', { clientId: 'oaiapp_1', email: null, subject: 's', idToken: 'x.y.z', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000, scope: 'chatgpt.tokens.use.direct', connectedAt: 1, needsReconnect: false });
    const limited = Object.assign(new Error('Too Many Requests'), { statusCode: 429, responseBody: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' });
    const ai = createAi({ db: t.db, settings, log, env: {}, chatgptAccessToken: async () => 'at-1', modelFactory: () => new MockLanguageModelV4({ doStream: async () => { throw limited; } }) });
    await expect(ask(ai)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });
});
