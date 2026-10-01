import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../tests/helpers/temp-db';
import { createAi } from './ai';
import { AI_SETTINGS_KEY } from './ai/settings';
import { createLogger } from './logging';
import { NOTIFICATION_SETTINGS_KEY } from './notifications/settings';
import { onboardingSteps } from './onboarding';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from './profile/model';
import { createProfileService } from './profile/service';
import { createQueue } from './queue';
import { createScheduler } from './scheduler';
import { createSettings } from './settings';
import { registerBuiltInAdapters } from './sources/adapters';
import { createSourceService } from './sources/service';
import { createFileStore } from './storage';

registerBuiltInAdapters();
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function deps(env: Record<string, string | undefined> = {}) {
  const settings = createSettings(t.db);
  const queue = createQueue(t.db);
  return {
    settings,
    profiles: createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'files')) }),
    sources: createSourceService({ db: t.db, settings }),
    scheduler: createScheduler({ settings, queue }),
    ai: createAi({ db: t.db, settings, log: createLogger({ level: 'silent' }), env }),
  };
}

describe('first-run setup steps (computed from what is really there)', () => {
  it('a fresh install starts at the first step, and nothing is done', () => {
    const s = onboardingSteps(deps());
    expect(s.steps.map((x) => x.id)).toEqual(['ai', 'cv', 'preferences', 'sources', 'notifications', 'start']);
    expect(s.steps.every((x) => !x.done)).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.next?.id).toBe('ai');
    expect(s.steps.every((x) => x.href.startsWith('/'))).toBe(true);
  });

  it('each step is done once its real setting exists; choosing to work without AI counts', () => {
    const d = deps();
    d.settings.set(AI_SETTINGS_KEY, { provider: 'none', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: null });
    const p = d.profiles.create('Me');
    const data = emptyProfile();
    data.headline = 'Backend Engineer';
    data.skills = [{ id: '', name: 'Go', category: 'technology' }];
    d.profiles.updateData(p.id, assignIds(data), { byUser: true });
    expect(onboardingSteps(d).next?.id).toBe('preferences');
    d.profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
    d.sources.ensureDefaults();
    d.settings.set(NOTIFICATION_SETTINGS_KEY, { channels: { inapp: true, browser: true, desktop: false, email: false, telegram: false }, events: {}, quietHours: null, emailTo: null });
    expect(onboardingSteps(d).next?.id).toBe('start');
    d.scheduler.start();
    const s = onboardingSteps(d);
    expect(s.complete).toBe(true);
    expect(s.next).toBeNull();
    expect(s.steps.find((x) => x.id === 'ai')?.detail).toMatch(/without AI/i);
  });

  it('a configured AI provider counts as done, with its name', () => {
    const d = deps({ OPENAI_API_KEY: 'sk-test-123456' });
    d.settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: null });
    expect(onboardingSteps(d).steps[0]).toMatchObject({ done: true, detail: expect.stringMatching(/openai/i) });
  });

  it('counts any profile, not only the default one (new-user review #3)', () => {
    const d = deps();
    d.profiles.create('Empty default');
    const real = d.profiles.create('Real');
    const data = emptyProfile();
    data.skills = [{ id: '', name: 'Go', category: 'technology' }];
    d.profiles.updateData(real.id, assignIds(data), { byUser: true });
    d.profiles.updatePreferences(real.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
    const s = onboardingSteps(d);
    expect(s.steps.find((x) => x.id === 'cv')).toMatchObject({ done: true, href: `/profiles/${real.id}` });
    expect(s.steps.find((x) => x.id === 'preferences')).toMatchObject({ done: true });
  });
});
