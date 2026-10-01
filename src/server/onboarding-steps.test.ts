import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../tests/helpers/temp-db';
import { createAi } from './ai';
import { AI_SETTINGS_KEY } from './ai/settings';
import { createLogger } from './logging';
import { RESCORE_TASK } from './matching/tasks';
import { onboardingStatus, readOnboarding, updateOnboarding } from './onboarding';
import { beginCvUpload, confirmProfile, cvWaitNotice, saveJobPreferences, startJobSearch, suggestedPreferences, type JobPreferencesInput } from './onboarding-steps';
import { createCvService } from './profile/cv-service';
import { createProfileService } from './profile/service';
import { createQueue } from './queue';
import { createScheduler, SCAN_TASK } from './scheduler';
import { createSettings } from './settings';
import { createFileStore } from './storage';
import { isOnboarded } from './onboarding';

const log = createLogger({ level: 'silent' });
const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/cvs/files', name));
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function ctx() {
  const settings = createSettings(t.db);
  const queue = createQueue(t.db);
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files });
  const cvs = createCvService({ db: t.db, files, queue, profiles, ai: null, log });
  const scheduler = createScheduler({ settings, queue, canScan: () => isOnboarded({ settings, profiles }) });
  const ai = createAi({ db: t.db, settings, log, env: { OPENAI_API_KEY: 'sk-test-123456' } });
  settings.set(AI_SETTINGS_KEY, { provider: 'openai', fastModel: null, qualityModel: null, baseUrl: null, dailyBudgetUsd: 2 });
  updateOnboarding(settings, (s) => ({ ...s, aiVerifiedAt: 1 }));
  return { settings, queue, profiles, cvs, scheduler, ai };
}
type Ctx = ReturnType<typeof ctx>;

async function uploadAndRead(c: Ctx, file = 'software-engineer-india.pdf') {
  const { profileId } = await beginCvUpload(c, { name: file, buf: fixture(file) });
  for (const cv of c.cvs.list(profileId)) if (cv.status === 'uploaded') await c.cvs.runExtraction(cv.id);
  return profileId;
}

const valid = (over: Partial<JobPreferencesInput> = {}): JobPreferencesInput => ({
  titles: ['Backend Engineer'],
  country: 'IN',
  states: ['Karnataka'],
  cities: ['Bangalore'],
  otherCountries: [],
  remoteScope: 'country',
  workModes: ['remote', 'hybrid'],
  employmentTypes: ['full-time'],
  expectedSalary: 2_400_000,
  currency: 'INR',
  negotiable: true,
  noticePeriod: '30 days',
  slider: 100,
  ...over,
});

describe('setup steps', () => {
  it('uploading a CV creates the main profile once; a new upload before confirming replaces it', async () => {
    const c = ctx();
    const first = await uploadAndRead(c);
    expect(c.profiles.list()).toHaveLength(1);
    expect(readOnboarding(c.settings)?.profileId).toBe(first);
    expect(onboardingStatus(c).step).toBe('review');
    const second = await uploadAndRead(c, 'nurse-uk.pdf');
    expect(c.profiles.list().map((p) => p.id)).toEqual([second]);
    expect(c.profiles.get(second)?.isDefault).toBe(true);
  });

  it('refuses files that are not a PDF or Word document', async () => {
    const c = ctx();
    await expect(beginCvUpload(c, { name: 'cv.txt', buf: Buffer.from('hello') })).rejects.toThrow(/PDF|docx/i);
    expect(c.profiles.list()).toHaveLength(0);
  });

  it('confirming the profile needs a read CV, then moves on to the job preferences', async () => {
    const c = ctx();
    expect(() => confirmProfile(c)).toThrow(/upload your cv/i);
    await uploadAndRead(c);
    confirmProfile(c);
    expect(onboardingStatus(c).step).toBe('preferences');
  });

  it('job preferences: says what is missing, field by field', async () => {
    const c = ctx();
    await uploadAndRead(c);
    confirmProfile(c);
    const r = saveJobPreferences(c, valid({ titles: [' '], country: '', workModes: [], employmentTypes: [], expectedSalary: null, currency: '' }));
    expect(r).toEqual({
      ok: false,
      errors: {
        titles: expect.stringMatching(/job title/i),
        country: expect.stringMatching(/country/i),
        workModes: expect.stringMatching(/remote, hybrid or on-site/i),
        employmentTypes: expect.stringMatching(/type of job/i),
        expectedSalary: expect.stringMatching(/expected salary/i),
        currency: expect.stringMatching(/currency/i),
      },
    });
    expect(onboardingStatus(c).step).toBe('preferences');
  });

  it('job preferences: saved for matching, and the expected salary and notice period for applications', async () => {
    const c = ctx();
    const id = await uploadAndRead(c);
    confirmProfile(c);
    expect(saveJobPreferences(c, valid({ otherCountries: ['GB'] }))).toEqual({ ok: true });
    const p = c.profiles.get(id)!;
    expect(p.preferences).toMatchObject({
      targetTitles: ['Backend Engineer'],
      locations: ['Bangalore, India', 'United Kingdom'],
      remoteScope: 'country',
      workModes: ['remote', 'hybrid'],
      employmentTypes: ['full-time'],
      salaryMin: 2_400_000,
      salaryCurrency: 'INR',
      salaryNegotiable: true,
    });
    expect(p.sliderValue).toBe(100);
    expect(p.data.application).toMatchObject({ expectedSalary: '2,400,000 INR per year (negotiable)', noticePeriod: '30 days' });
    expect(onboardingStatus(c).step).toBe('start');
  });

  it('a state without cities becomes the location, with its country', async () => {
    const c = ctx();
    const id = await uploadAndRead(c);
    confirmProfile(c);
    saveJobPreferences(c, valid({ cities: [] }));
    expect(c.profiles.get(id)!.preferences.locations).toEqual(['Karnataka, India']);
  });

  it('Start finishes setup, starts the search at the chosen interval and matches the jobs found so far', async () => {
    const c = ctx();
    expect(() => startJobSearch(c, 60)).toThrow(/earlier steps/i);
    const id = await uploadAndRead(c);
    confirmProfile(c);
    saveJobPreferences(c, valid());
    startJobSearch(c, 120);
    expect(isOnboarded(c)).toBe(true);
    expect(c.scheduler.getState()).toMatchObject({ enabled: true, intervalMinutes: 120 });
    // Due at once: the worker's next tick queues the first scan.
    expect(c.scheduler.tick()).toBe(true);
    expect(c.queue.claim('w', [SCAN_TASK])).toBeTruthy();
    expect(c.queue.claim('w', [RESCORE_TASK])?.payload).toEqual({ profileId: id });
  });

  it('after every profile was deleted, uploading a CV runs setup again from the review', async () => {
    const c = ctx();
    const id = await uploadAndRead(c);
    confirmProfile(c);
    saveJobPreferences(c, valid());
    startJobSearch(c, 60);
    await c.profiles.delete(id);
    await uploadAndRead(c);
    expect(isOnboarded(c)).toBe(false);
    expect(onboardingStatus(c).step).toBe('review');
  });

  it('suggests preferences from the CV: titles, country, currency and notice period', async () => {
    const c = ctx();
    const id = await uploadAndRead(c);
    const s = suggestedPreferences(c.profiles.get(id)!);
    expect(s.titles.length).toBeGreaterThan(0);
    expect(s.country).toBe('IN');
    expect(s.currency).toBe('INR');
    expect(s).toMatchObject({ remoteScope: 'country', employmentTypes: ['full-time'], slider: 100 });
  });

  it('coming back to the job preferences shows what was chosen before', async () => {
    const c = ctx();
    const id = await uploadAndRead(c);
    confirmProfile(c);
    saveJobPreferences(c, valid({ cities: [], states: ['Karnataka', 'Tamil Nadu'], otherCountries: ['GB'], expectedSalary: 3_000_000, negotiable: false }));
    expect(suggestedPreferences(c.profiles.get(id)!)).toMatchObject({ country: 'IN', states: ['Karnataka', 'Tamil Nadu'], cities: [], otherCountries: ['GB'], expectedSalary: 3_000_000, negotiable: false });
    saveJobPreferences(c, valid({ cities: ['Bangalore', 'Mysore'] }));
    expect(suggestedPreferences(c.profiles.get(id)!)).toMatchObject({ country: 'IN', states: [], cities: ['Bangalore', 'Mysore'] });
  });

  it('upgrading with an unfinished profile: the profile made in setup becomes the default one', async () => {
    const c = ctx();
    const old = c.profiles.create('Old, never finished');
    expect(c.profiles.get(old.id)?.isDefault).toBe(true);
    const id = await uploadAndRead(c);
    expect(c.profiles.get(id)?.isDefault).toBe(true);
    expect(c.profiles.get(old.id)?.isDefault).toBe(false);
  });

  it('while the CV is read, says when the background worker is not running, or when it takes unusually long', () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const reading = { status: 'extracting', uploadedAt: at };
    expect(cvWaitNotice({ workerOnline: false, cv: reading, now: at })).toMatch(/worker isn.t running.*pnpm start/i);
    expect(cvWaitNotice({ workerOnline: false, cv: null, now: at })).toMatch(/worker isn.t running/i);
    expect(cvWaitNotice({ workerOnline: true, cv: reading, now: new Date(at.getTime() + 60_000) })).toBeNull();
    expect(cvWaitNotice({ workerOnline: true, cv: reading, now: new Date(at.getTime() + 4 * 60_000) })).toMatch(/longer than usual/i);
    expect(cvWaitNotice({ workerOnline: true, cv: { status: 'applied', uploadedAt: at }, now: new Date(at.getTime() + 9 * 60_000) })).toBeNull();
  });
});
