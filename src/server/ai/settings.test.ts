import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_SETTINGS, mergeAiSettings, AI_TASKS, migrateAiSettings } from './settings';

describe('migrateAiSettings', () => {
  const old = { provider: 'claude-code' as const, fastModel: 'haiku', qualityModel: 'sonnet', baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 };

  it('routes every task to the old provider, by the role it used', () => {
    const s = migrateAiSettings(old, {});
    expect(Object.keys(s.tasks).sort()).toEqual([...AI_TASKS].sort());
    expect(s.tasks['jd-analysis']).toEqual({ provider: 'claude-code', model: 'haiku' });
    expect(s.tasks['cover-letter']).toEqual({ provider: 'claude-code', model: 'sonnet' });
    expect(s.tasks['cv-tailor']).toEqual({ provider: 'claude-code', model: 'sonnet' });
  });

  it('carries the old limits and base URL onto that provider', () => {
    const s = migrateAiSettings({ ...old, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/api' }, {});
    expect(s.providers.ollama).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/api', dailyBudgetUsd: 2, dailyCallLimit: 300 });
  });

  it('seeds CV reading with Gemini 3 Flash when a Gemini key is set (keeps D-30)', () => {
    expect(migrateAiSettings(old, { GEMINI_API_KEY: 'k' }).tasks['cv-extract']).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' });
    expect(migrateAiSettings(old, {}).tasks['cv-extract']).toEqual({ provider: 'claude-code', model: 'haiku' });
  });

  it('falls back to the provider default when a role model was never set', () => {
    expect(migrateAiSettings({ ...old, provider: 'openai', fastModel: null, qualityModel: null }, {}).tasks['jd-analysis']).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('keeps an offline install offline, and accepts a missing or already-new row', () => {
    expect(migrateAiSettings({ ...old, provider: 'none' }, {}).tasks['match-evaluate']).toEqual({ provider: 'none', model: null });
    expect(migrateAiSettings(undefined, {})).toEqual(DEFAULT_AI_SETTINGS);
    const already = migrateAiSettings(old, {});
    expect(migrateAiSettings(already, {})).toEqual(already);
  });

  // Finding 1: offline install does NOT get AI switched on by Gemini key (rules §49-52)
  it('does not apply Gemini seed to offline (provider:none) installs even with Gemini key', () => {
    const s = migrateAiSettings({ ...old, provider: 'none' }, { GEMINI_API_KEY: 'k' });
    expect(s.tasks['cv-extract']).toEqual({ provider: 'none', model: null });
    expect(s.tasks['jd-analysis']).toEqual({ provider: 'none', model: null });
  });

  // Finding 2: partially populated new-shape rows are accepted and filled with offline routes
  it('accepts a partially populated new-shape row and fills gaps with offline routes', () => {
    const partial = {
      providers: { anthropic: { baseUrl: null, dailyBudgetUsd: 5, dailyCallLimit: 100 } },
      tasks: {
        'cv-extract': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        'jd-analysis': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        'cover-letter': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      },
    };
    const s = migrateAiSettings(partial, {});
    // The 3 provided tasks are kept
    expect(s.tasks['cv-extract']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    // The other 5 are filled with offline
    expect(s.tasks['match-evaluate']).toEqual({ provider: 'none', model: null });
    expect(s.tasks['web-job-extract']).toEqual({ provider: 'none', model: null });
    expect(s.tasks['form-answers']).toEqual({ provider: 'none', model: null });
    expect(s.tasks['inbox-classify']).toEqual({ provider: 'none', model: null });
    expect(s.tasks['cv-tailor']).toEqual({ provider: 'none', model: null });
    // Providers are preserved
    expect(s.providers.anthropic).toMatchObject({ dailyBudgetUsd: 5, dailyCallLimit: 100 });
  });

  // Finding 2 continued: null, string, or bad data returns default
  it('accepts null, string, or bad input gracefully and returns default', () => {
    expect(migrateAiSettings(null, {})).toEqual(DEFAULT_AI_SETTINGS);
    expect(migrateAiSettings('not a settings object', {})).toEqual(DEFAULT_AI_SETTINGS);
    expect(migrateAiSettings({ invalid: 'object' }, {})).toEqual(DEFAULT_AI_SETTINGS);
  });

  // Finding 3: unknown task id or provider id is rejected
  it('rejects unknown task ids or provider ids in new-shape rows', () => {
    const unknownTask = {
      providers: {},
      tasks: { 'cv-tailer': { provider: 'none', model: null } },
    };
    expect(() => migrateAiSettings(unknownTask, {})).toThrow();

    const unknownProvider = {
      providers: { opnai: { baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 } },
      tasks: { 'cv-extract': { provider: 'opnai', model: 'gpt-5' } },
    };
    expect(() => migrateAiSettings(unknownProvider, {})).toThrow();
  });

  // Finding 1 continued: Gemini seed adds providers.google with defaults
  it('when Gemini seed is applied, adds providers.google entry with defaults', () => {
    const s = migrateAiSettings(old, { GEMINI_API_KEY: 'k' });
    expect(s.providers.google).toEqual({ baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 });
    expect(s.tasks['cv-extract']).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' });
  });
});
