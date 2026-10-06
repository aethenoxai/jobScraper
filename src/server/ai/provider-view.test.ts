import { describe, expect, it } from 'vitest';
import { applyProviderForm, modelNote, providerRows, testBaseUrl, testModelFor, type ProviderStatusLike } from './provider-view';
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
