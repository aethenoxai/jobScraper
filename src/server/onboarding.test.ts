import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../tests/helpers/temp-db';
import { createAi } from './ai';
import { AI_SETTINGS_KEY } from './ai/settings';
import { createLogger } from './logging';
import { isOnboarded, ONBOARDING_KEY, onboardingStatus, readOnboarding, recordEarlierSetup, updateOnboarding } from './onboarding';
import { createCvService } from './profile/cv-service';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from './profile/model';
import { createProfileService } from './profile/service';
import { createQueue } from './queue';
import { createSettings } from './settings';
import { createFileStore } from './storage';

const log = createLogger({ level: 'silent' });
const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/cvs/files', name));
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function deps(env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-test-123456' }) {
  const settings = createSettings(t.db);
  const queue = createQueue(t.db);
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files });
  return {
    settings,
    profiles,
    cvs: createCvService({ db: t.db, files, queue, profiles, ai: null, log }),
    ai: createAi({ db: t.db, settings, log, env }),
  };
}

type Deps = ReturnType<typeof deps>;

function connectAi(d: Deps) {
  d.settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: 2 });
  updateOnboarding(d.settings, (s) => ({ ...s, aiVerifiedAt: 1 }));
}

/** Uploads a CV for a new profile and runs the (offline) extraction, as the worker would. */
async function profileWithCv(d: Deps) {
  const p = d.profiles.create('Main profile');
  updateOnboarding(d.settings, (s) => ({ ...s, profileId: p.id }));
  const cv = await d.cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'));
  await d.cvs.runExtraction(cv.id);
  return p;
}

function filledProfile(d: Deps, titles: string[]) {
  const p = d.profiles.create('Mine');
  const data = emptyProfile();
  data.skills = [{ id: '', name: 'Go', category: 'technology' }];
  d.profiles.updateData(p.id, assignIds(data), { byUser: true });
  if (titles.length) d.profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: titles }, 100);
  return p;
}

describe('onboarding: one step at a time, worked out from what is saved', () => {
  it('a fresh install starts at the AI step and is not onboarded', () => {
    const d = deps();
    expect(onboardingStatus(d).step).toBe('ai');
    expect(isOnboarded(d)).toBe(false);
    expect(readOnboarding(d.settings)).toBeNull();
  });

  it('stays on the AI step until a model was tested, and again if it stops being configured', () => {
    const d = deps();
    d.settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: 2 });
    expect(onboardingStatus(d).step).toBe('ai');
    updateOnboarding(d.settings, (s) => ({ ...s, aiVerifiedAt: 1 }));
    expect(onboardingStatus(d).step).toBe('cv');
    const noKey = { ...d, ai: createAi({ db: t.db, settings: d.settings, log, env: {} }) };
    expect(onboardingStatus(noKey).step).toBe('ai');
  });

  it('waits on the CV step while the CV is being read, and shows a failed one', async () => {
    const d = deps();
    connectAi(d);
    const p = d.profiles.create('Main profile');
    updateOnboarding(d.settings, (s) => ({ ...s, profileId: p.id }));
    const cv = await d.cvs.upload(p.id, 'cv.pdf', fixture('software-engineer-india.pdf'));
    expect(onboardingStatus(d)).toMatchObject({ step: 'cv', cv: { id: cv.id, status: 'uploaded' }, profile: { id: p.id } });
    const bad = await d.cvs.upload(p.id, 'scan.pdf', fixture('image-only.pdf'));
    await d.cvs.runExtraction(bad.id).catch(() => undefined);
    expect(onboardingStatus(d)).toMatchObject({ step: 'cv', cv: { id: bad.id, status: 'failed' } });
  });

  it('goes review → preferences → start → done as each is confirmed', async () => {
    const d = deps();
    connectAi(d);
    await profileWithCv(d);
    expect(onboardingStatus(d).step).toBe('review');
    updateOnboarding(d.settings, (s) => ({ ...s, profileConfirmedAt: 2 }));
    expect(onboardingStatus(d).step).toBe('preferences');
    updateOnboarding(d.settings, (s) => ({ ...s, preferencesConfirmedAt: 3 }));
    expect(onboardingStatus(d).step).toBe('start');
    expect(isOnboarded(d)).toBe(false);
    updateOnboarding(d.settings, (s) => ({ ...s, completedAt: 4 }));
    expect(onboardingStatus(d).step).toBe('done');
    expect(isOnboarded(d)).toBe(true);
  });

  it('after every profile is deleted, the wizard opens again at the CV step and the install is not onboarded', async () => {
    const d = deps();
    connectAi(d);
    const p = await profileWithCv(d);
    updateOnboarding(d.settings, (s) => ({ ...s, profileConfirmedAt: 2, preferencesConfirmedAt: 3, completedAt: 4 }));
    await d.profiles.delete(p.id);
    expect(isOnboarded(d)).toBe(false);
    expect(onboardingStatus(d)).toMatchObject({ step: 'cv', profile: null, cv: null });
  });

  it('confirmations belong to the onboarding profile: a missing profile resets them', () => {
    const d = deps();
    connectAi(d);
    updateOnboarding(d.settings, (s) => ({ ...s, profileId: 999, profileConfirmedAt: 2, preferencesConfirmedAt: 3 }));
    expect(onboardingStatus(d).step).toBe('cv');
  });

  it('an install from before onboarding existed, with a filled profile and target titles, counts as onboarded', () => {
    const d = deps({});
    filledProfile(d, ['Backend Engineer']);
    expect(isOnboarded(d)).toBe(true);
    expect(onboardingStatus(d).step).toBe('done');
  });

  it('an older install with only an empty or title-less profile still goes through onboarding', () => {
    const d = deps({});
    d.profiles.create('Empty');
    filledProfile(d, []);
    expect(isOnboarded(d)).toBe(false);
  });

  it('keeps its state in settings, filling in what was never set', () => {
    const d = deps();
    updateOnboarding(d.settings, (s) => ({ ...s, aiVerifiedAt: 5 }));
    expect(t.sqlite.prepare('select key from settings where key = ?').get(ONBOARDING_KEY)).toBeTruthy();
    expect(readOnboarding(d.settings)).toEqual({ profileId: null, aiVerifiedAt: 5, profileConfirmedAt: null, preferencesConfirmedAt: null, completedAt: null });
  });

  it('an older install counted as set up stays set up after its target titles are cleared (saved once, at start)', () => {
    const d = deps({});
    const p = filledProfile(d, ['Backend Engineer']);
    expect(recordEarlierSetup(d)).toBe(true);
    expect(readOnboarding(d.settings)).toMatchObject({ profileId: p.id, completedAt: expect.any(Number) });
    d.profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: [] }, 100);
    expect(isOnboarded(d)).toBe(true);
  });

  it('saves nothing for a fresh install, an unfinished older one, or one that already has a record', () => {
    const fresh = deps({});
    expect(recordEarlierSetup(fresh)).toBe(false);
    fresh.profiles.create('Empty');
    expect(recordEarlierSetup(fresh)).toBe(false);
    expect(readOnboarding(fresh.settings)).toBeNull();
    updateOnboarding(fresh.settings, (s) => ({ ...s, aiVerifiedAt: 1 }));
    filledProfile(fresh, ['Backend Engineer']);
    expect(recordEarlierSetup(fresh)).toBe(false);
    expect(readOnboarding(fresh.settings)?.completedAt).toBeNull();
  });
});
