import { describe, expect, it } from 'vitest';
import { seedTasks } from './seed';
import { AI_TASKS, DEFAULT_AI_SETTINGS } from './settings';

describe('seedTasks', () => {
  it('routes every task to the first ready provider, quality models for the writing tasks', () => {
    const t = seedTasks(DEFAULT_AI_SETTINGS.tasks, ['openai', 'anthropic'], true);
    expect(AI_TASKS.every((k) => t[k]?.provider === 'openai')).toBe(true);
    expect(t['jd-analysis']?.model).toBe('gpt-5-mini');
    expect(t['cv-tailor']?.model).toBe('gpt-5');
  });
  it('reads the CV with Gemini 3 Flash whenever Google is ready', () => {
    const t = seedTasks(DEFAULT_AI_SETTINGS.tasks, ['openai', 'google'], true);
    expect(t['cv-extract']).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' });
    expect(t['cover-letter']?.provider).toBe('openai');
  });
  it('leaves everything offline when nothing is ready', () => {
    expect(seedTasks(DEFAULT_AI_SETTINGS.tasks, [], true)).toBe(DEFAULT_AI_SETTINGS.tasks);
  });
  it('never overwrites routes the user already chose', () => {
    const saved = { ...DEFAULT_AI_SETTINGS.tasks, 'cv-extract': { provider: 'ollama' as const, model: 'llama3.1' } };
    expect(seedTasks(saved, ['google'], true)).toBe(saved);
  });
  it('does not re-fill a saved all-None choice (not a fresh install)', () => {
    expect(seedTasks(DEFAULT_AI_SETTINGS.tasks, ['google'], false)).toBe(DEFAULT_AI_SETTINGS.tasks);
  });
});
