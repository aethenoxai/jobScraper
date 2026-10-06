import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createSettings } from '../settings';
import { AI_SETTINGS_KEY } from './settings';
import { migrateAiSettings } from './settings';
import { taskRow, updateAiSettings, aiStateLine, applyProviderForm, applyTaskForm, defaultModelFor, limitReached, modelNote, providerRows, testBaseUrl, testModelFor, type ProviderStatusLike } from './provider-view';
import { DEFAULT_AI_SETTINGS, type AiSettings } from './settings';

const status = (over: Partial<ProviderStatusLike>): ProviderStatusLike => ({ provider: 'google', configured: true, reason: null, keyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY', keyPresent: true, baseUrl: null, spentTodayUsd: 0, callsToday: 0, dailyBudgetUsd: 2, dailyCallLimit: 300, ...over });
const routed = (provider: 'google' | 'openai', tasks: string[], model = 'm'): AiSettings => ({ ...DEFAULT_AI_SETTINGS, tasks: { ...DEFAULT_AI_SETTINGS.tasks, ...Object.fromEntries(tasks.map((t) => [t, { provider, model }])) } });

describe('providerRows', () => {
  it('warns in human words when a routed provider has no key', () => {
    const [row] = providerRows([status({ configured: false, keyPresent: false, reason: 'Add GOOGLE_GENERATIVE_AI_API_KEY to your .env file.' })], routed('google', ['cv-extract', 'jd-analysis']));
    expect(row.warning).toContain('reading your cv and understanding a job post');
    expect(row.warning).not.toContain('cv-extract');
  });
  it('has no warning when nothing is routed there or the provider is ready', () => {
    expect(providerRows([status({ configured: false, reason: 'x' })], DEFAULT_AI_SETTINGS)[0].warning).toBeNull();
    expect(providerRows([status({})], routed('google', ['cv-extract']))[0].warning).toBeNull();
  });
  it('uses dollars for keyed providers, calls for plan providers, and skips "none"', () => {
    const rows = providerRows([status({ provider: 'none' }), status({ spentTodayUsd: 0.5, callsToday: 3 }), status({ provider: 'chatgpt', keyEnvVar: null, callsToday: 7, dailyCallLimit: 50 })], DEFAULT_AI_SETTINGS);
    expect(rows.map((r) => r.provider)).toEqual(['google', 'chatgpt']);
    expect(rows[0]).toMatchObject({ limitKind: 'usd', limit: 2, usedToday: '$0.500 (3 calls)' });
    expect(rows[1]).toMatchObject({ limitKind: 'calls', limit: 50, usedToday: '7 calls' });
  });
  it('asks for a base URL only for local and compatible servers', () => {
    const rows = providerRows([status({ provider: 'ollama' }), status({ provider: 'openai-compatible' }), status({})], DEFAULT_AI_SETTINGS);
    expect(rows.map((r) => r.needsBaseUrl)).toEqual([true, true, false]);
  });
});

describe('modelNote', () => {
  it('says plainly when the live list failed, never the raw error', () => {
    expect(modelNote('openai', { models: ['gpt-5'], source: 'fallback', error: 'The provider answered 500; showing the built-in list.' })).toBe('Couldn’t reach OpenAI: showing known models.');
  });
  it('is silent for live lists and for providers with a built-in list only', () => {
    expect(modelNote('openai', { models: ['a'], source: 'live' })).toBeNull();
    expect(modelNote('chatgpt', { models: ['a'], source: 'fallback' })).toBeNull();
  });
});

describe('testModelFor', () => {
  it('prefers a model a task already uses, else the default fast model', () => {
    expect(testModelFor('google', routed('google', ['cv-tailor'], 'gemini-x'))).toBe('gemini-x');
    expect(testModelFor('openai', DEFAULT_AI_SETTINGS)).toBe('gpt-5-mini');
    expect(testModelFor('openai-compatible', DEFAULT_AI_SETTINGS)).toBe('');
  });
});

describe('applyProviderForm', () => {
  it('sets a dollar limit and an address, clears empty ones, and leaves other providers alone', () => {
    const start = applyProviderForm(DEFAULT_AI_SETTINGS, { 'openai.limit': '5', 'ollama.baseUrl': 'http://127.0.0.1:11434/api' });
    expect(start.providers.openai?.dailyBudgetUsd).toBe(5);
    expect(start.providers.ollama?.baseUrl).toBe('http://127.0.0.1:11434/api');
    const next = applyProviderForm(start, { 'openai.limit': '', 'chatgpt.limit': '40' });
    expect(next.providers.openai?.dailyBudgetUsd).toBeNull();
    expect(next.providers.chatgpt?.dailyCallLimit).toBe(40);
    expect(next.providers.ollama?.baseUrl).toBe('http://127.0.0.1:11434/api');
  });
  it('refuses bad values with a readable message', () => {
    expect(() => applyProviderForm(DEFAULT_AI_SETTINGS, { 'openai.limit': '-1' })).toThrow(/dollar amount/);
    expect(() => applyProviderForm(DEFAULT_AI_SETTINGS, { 'chatgpt.limit': '1.5' })).toThrow(/whole number/);
    expect(() => applyProviderForm(DEFAULT_AI_SETTINGS, { 'ollama.baseUrl': 'ftp://x' })).toThrow(/http\(s\)/);
  });
});

describe('testBaseUrl', () => {
  it('drops an address for providers that send a key, keeps it for local and compatible servers', () => {
    expect(testBaseUrl('openai', 'https://evil.example')).toBeUndefined();
    expect(testBaseUrl('anthropic', 'https://evil.example')).toBeUndefined();
    expect(testBaseUrl('google', 'https://evil.example')).toBeUndefined();
    expect(testBaseUrl('ollama', ' http://127.0.0.1:11434/api ')).toBe('http://127.0.0.1:11434/api');
    expect(testBaseUrl('openai-compatible', '')).toBeUndefined();
  });
});

describe('applyProviderForm address rule', () => {
  it('stores an address only for ollama and openai-compatible', () => {
    const out = applyProviderForm(DEFAULT_AI_SETTINGS, { 'openai.baseUrl': 'https://evil.example/v1', 'ollama.baseUrl': 'http://127.0.0.1:11434/api', 'openai-compatible.baseUrl': 'https://srv/v1' });
    expect(out.providers.openai?.baseUrl).toBeNull();
    expect(out.providers.ollama?.baseUrl).toBe('http://127.0.0.1:11434/api');
    expect(out.providers['openai-compatible']?.baseUrl).toBe('https://srv/v1');
  });
  it('clears an address an older version stored for a keyed provider', () => {
    const cur: AiSettings = { ...DEFAULT_AI_SETTINGS, providers: { google: { baseUrl: 'https://old.example', dailyBudgetUsd: 2, dailyCallLimit: 300 } } };
    expect(applyProviderForm(cur, { 'google.baseUrl': 'https://old.example' }).providers.google?.baseUrl).toBeNull();
  });
});

describe('applyTaskForm', () => {
  const cur = routed('google', ['cv-extract', 'jd-analysis'], 'gemini-x');
  it('keeps a task that is absent from the form', () => {
    const out = applyTaskForm(cur, { 'tasks.cv-extract.provider': 'google', 'tasks.cv-extract.model': 'new' });
    expect(out.tasks['cv-extract']).toEqual({ provider: 'google', model: 'new' });
    expect(out.tasks['jd-analysis']).toEqual({ provider: 'google', model: 'gemini-x' });
  });
  it('keeps the stored model when only the provider field is missing, and the stored provider when only the model is sent', () => {
    expect(applyTaskForm(cur, { 'tasks.cv-extract.model': 'm2' }).tasks['cv-extract']).toEqual({ provider: 'google', model: 'm2' });
    expect(applyTaskForm(cur, { 'tasks.cv-extract.provider': 'google' }).tasks['cv-extract']).toEqual({ provider: 'google', model: 'gemini-x' });
  });
  it('drops the old provider’s model when the provider changes and no model is sent', () => {
    expect(applyTaskForm(cur, { 'tasks.cv-extract.provider': 'openai' }).tasks['cv-extract']).toEqual({ provider: 'openai', model: null });
  });
  it('takes the submitted model with a new provider, and never keeps a model for none', () => {
    expect(applyTaskForm(cur, { 'tasks.cv-extract.provider': 'openai', 'tasks.cv-extract.model': ' gpt-5-mini ' }).tasks['cv-extract']).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
    expect(applyTaskForm(cur, { 'tasks.cv-extract.provider': 'none', 'tasks.cv-extract.model': 'x' }).tasks['cv-extract']).toEqual({ provider: 'none', model: null });
  });
  it('treats an empty model as unset', () => {
    expect(applyTaskForm(cur, { 'tasks.cv-extract.provider': 'google', 'tasks.cv-extract.model': '  ' }).tasks['cv-extract']?.model).toBeNull();
  });
  it('rejects unknown tasks, providers and malformed task keys instead of writing them', () => {
    expect(() => applyTaskForm(cur, { 'tasks.nope.provider': 'google' })).toThrow();
    expect(() => applyTaskForm(cur, { 'tasks.cv-extract.provider': 'skynet' })).toThrow();
    expect(() => applyTaskForm(cur, { 'tasks.cv-extract.colour': 'red' })).toThrow();
    expect(() => applyTaskForm(cur, { 'tasks.__proto__.provider': 'google' })).toThrow();
  });
  it('ignores fields that are not task fields and is idempotent', () => {
    const form = { 'tasks.cv-extract.provider': 'openai', 'tasks.cv-extract.model': 'gpt-5', other: 'x' };
    const once = applyTaskForm(cur, form);
    expect(applyTaskForm(once, form)).toEqual(once);
    expect(applyTaskForm(cur, {})).toEqual(cur);
  });
  it('does not change the settings it was given', () => {
    const copy = structuredClone(cur);
    applyTaskForm(cur, { 'tasks.cv-extract.provider': 'openai' });
    expect(cur).toEqual(copy);
  });
});

describe('defaultModelFor', () => {
  it('uses the provider default, else the first listed, else empty', () => {
    expect(defaultModelFor('openai', ['a'])).toBe('gpt-5-mini');
    expect(defaultModelFor('openai-compatible', ['srv-model'])).toBe('srv-model');
    expect(defaultModelFor('openai-compatible', [])).toBe('');
    expect(defaultModelFor('none', ['a'])).toBe('');
  });
});

describe('limits and the state line', () => {
  it('detects a used-up budget or call limit', () => {
    expect(limitReached(status({ spentTodayUsd: 2 }))).toBe(true);
    expect(limitReached(status({ spentTodayUsd: 1.99 }))).toBe(false);
    expect(limitReached(status({ dailyBudgetUsd: null, spentTodayUsd: 99 }))).toBe(false);
    expect(limitReached(status({ provider: 'chatgpt', callsToday: 300 }))).toBe(true);
  });
  it('says plainly that a provider at its limit puts its tasks on offline rules', () => {
    const [row] = providerRows([status({ spentTodayUsd: 2 })], routed('google', ['cv-extract']));
    expect(row.warning).toContain('reading your cv run on offline rules until tomorrow');
  });
  const t = (task: string, provider: string, configured: boolean) => ({ task, provider, configured }) as Parameters<typeof aiStateLine>[0][number];
  it('describes all-AI, all-offline and mixed states', () => {
    expect(aiStateLine([t('cv-extract', 'google', true), t('jd-analysis', 'google', true)], new Set())).toBe('All 2 tasks run on AI.');
    expect(aiStateLine([t('cv-extract', 'none', false)], new Set())).toMatch(/^Offline: no task uses AI/);
    const mixed = aiStateLine([t('cv-extract', 'google', true), t('jd-analysis', 'none', false), t('cv-tailor', 'openai', false), t('cover-letter', 'chatgpt', true)], new Set(['chatgpt']));
    expect(mixed).toContain('1 of 4 tasks run on AI.');
    expect(mixed).toContain('Offline by choice: understanding a job post.');
    expect(mixed).toContain('Not ready, so on offline rules for now: tailoring your cv.');
    expect(mixed).toContain('Daily limit reached, on offline rules until tomorrow: writing a cover letter.');
  });
});

describe('taskRow', () => {
  it('shows a model missing from the live list in the free-text field', () => {
    expect(taskRow('ollama', 'llama3.1', ['llama3.1:latest'])).toEqual({ provider: 'ollama', model: 'llama3.1', other: true });
    expect(taskRow('google', 'gemini-2.5-pro', ['gemini-2.5-pro'])).toMatchObject({ other: false });
    expect(taskRow('openai', null, ['a'])).toEqual({ provider: 'openai', model: '', other: false });
    expect(taskRow('none', null, [])).toMatchObject({ other: false });
  });
});

describe('updateAiSettings', () => {
  it('keeps both changes when a provider save and a task save follow each other', () => {
    const t = createTempDb();
    try {
      const settings = createSettings(t.db);
      updateAiSettings(settings, {}, (c) => applyProviderForm(c, { 'openai.limit': '7' }));
      updateAiSettings(settings, {}, (c) => applyTaskForm(c, { 'tasks.cv-extract.provider': 'openai', 'tasks.cv-extract.model': 'gpt-5' }));
      const now = migrateAiSettings(settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), {});
      expect(now.providers.openai?.dailyBudgetUsd).toBe(7);
      expect(now.tasks['cv-extract']).toEqual({ provider: 'openai', model: 'gpt-5' });
    } finally {
      t.cleanup();
    }
  });
});
