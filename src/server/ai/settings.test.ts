import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_SETTINGS, mergeAiSettings } from './settings';

describe('mergeAiSettings', () => {
  const current = { provider: 'openai' as const, fastModel: 'gpt-x', qualityModel: null, baseUrl: null, dailyBudgetUsd: 2, dailyCallLimit: 300 };

  it('keeps fields the form did not send (e.g. budget hidden while provider is None)', () => {
    expect(mergeAiSettings(current, { provider: 'none' })).toMatchObject({ provider: 'none', dailyBudgetUsd: 2 });
  });

  it('clears model overrides when the provider changes', () => {
    expect(mergeAiSettings(current, { provider: 'anthropic' })).toMatchObject({ provider: 'anthropic', fastModel: null, qualityModel: null });
  });

  it('applies submitted values, treating empty strings as unset', () => {
    expect(mergeAiSettings(current, { provider: 'openai', fastModel: 'gpt-y', dailyBudgetUsd: '' })).toMatchObject({ fastModel: 'gpt-y', dailyBudgetUsd: null });
    expect(mergeAiSettings(DEFAULT_AI_SETTINGS, { provider: 'openai', dailyBudgetUsd: '5' })).toMatchObject({ dailyBudgetUsd: 5 });
  });

  it('rejects invalid input', () => {
    expect(() => mergeAiSettings(current, { provider: 'skynet' })).toThrow();
  });

  it('reads the daily call limit for plan sign-ins (empty = no limit)', () => {
    expect(mergeAiSettings(current, { provider: 'chatgpt', dailyCallLimit: '50' })).toMatchObject({ dailyCallLimit: 50 });
    expect(mergeAiSettings(current, { provider: 'chatgpt', dailyCallLimit: '' })).toMatchObject({ dailyCallLimit: null });
    expect(mergeAiSettings(current, { provider: 'chatgpt' })).toMatchObject({ dailyCallLimit: 300 });
    expect(() => mergeAiSettings(current, { provider: 'chatgpt', dailyCallLimit: '0' })).toThrow();
  });
});
