/**
 * What each onboarding step saves (PRD §7, §9): the CV becomes the main profile, the user confirms it, says which
 * jobs they want (where, what pay), and starts the search. Server actions in src/app/welcome call these.
 */
import { countryChoices, currencyOf, composeLocations, displayPlace, resolvePlaces } from './matching/geo';
import { RESCORE_TASK } from './matching/tasks';
import { isOnboarded, onboardingStatus, readOnboarding, updateOnboarding } from './onboarding';
import type { Ai } from './ai';
import type { CvService } from './profile/cv-service';
import { sniffCvType, UnsupportedCvTypeError } from './profile/cv-text';
import { EMPLOYMENT_TYPES, formatExpectedSalary, SLIDER_MAX, SLIDER_MIN, WORK_MODES, type Preferences } from './profile/model';
import type { ProfileRecord, ProfileService } from './profile/service';
import type { Queue } from './queue';
import { isValidInterval, type Scheduler } from './scheduler';
import type { SettingsStore } from './settings';

export interface OnboardingContext {
  settings: SettingsStore;
  profiles: ProfileService;
  cvs: CvService;
  scheduler: Scheduler;
  queue: Queue;
  ai: Pick<Ai, 'taskStatus'>;
  now?: () => Date;
}

const nowMs = (c: OnboardingContext) => (c.now ?? (() => new Date()))().getTime();

/**
 * Stores the CV for the onboarding profile and queues reading it. Before setup is finished a new upload replaces the
 * profile made from an earlier one (nothing in it was confirmed yet).
 */
export async function beginCvUpload(c: OnboardingContext, file: { name: string; buf: Buffer }): Promise<{ profileId: number }> {
  if (!sniffCvType(file.buf)) throw new UnsupportedCvTypeError();
  if (isOnboarded(c)) throw new Error('Setup is already finished: add CVs on the Profiles page.');
  const state = readOnboarding(c.settings);
  const earlier = state?.profileId != null ? c.profiles.get(state.profileId) : null;
  if (earlier) await c.profiles.delete(earlier.id);
  const profile = c.profiles.create('Main profile');
  // An older install may have an unfinished profile: the dashboard and feed should open on this one.
  c.profiles.setDefault(profile.id);
  updateOnboarding(c.settings, (s) => ({ ...s, profileId: profile.id, cvAcceptedAt: null, profileConfirmedAt: null, preferencesConfirmedAt: null, completedAt: null }));
  await c.cvs.upload(profile.id, file.name, file.buf);
  return { profileId: profile.id };
}

/** Continue after the CV was read. */
export function acceptCv(c: OnboardingContext): void {
  const { profile, cv } = onboardingStatus(c);
  if (!profile || !cv || cv.status !== 'applied') throw new Error('Upload your CV first; it is read before you can go on.');
  updateOnboarding(c.settings, (s) => ({ ...s, cvAcceptedAt: nowMs(c) }));
}

/** Remove: the CV and the draft profile made from it go (also while it is being read); setup starts the CV step again. */
export async function removeCv(c: OnboardingContext): Promise<void> {
  if (isOnboarded(c)) throw new Error('Setup is already finished: manage CVs on the Profiles page.');
  const id = readOnboarding(c.settings)?.profileId;
  if (id != null && c.profiles.get(id)) await c.profiles.delete(id);
  updateOnboarding(c.settings, (s) => ({ ...s, profileId: null, cvAcceptedAt: null, profileConfirmedAt: null, preferencesConfirmedAt: null }));
}

/** Try again: read the CV that failed once more. */
export function retryCv(c: OnboardingContext): void {
  const { cv } = onboardingStatus(c);
  if (cv?.status === 'failed') c.cvs.retry(cv.id);
}

/** The user checked (and maybe edited) what was read from the CV. */
export function confirmProfile(c: OnboardingContext): void {
  const { step } = onboardingStatus(c);
  if (step === 'ai' || step === 'cv') throw new Error('Upload your CV first; it is read before you can check it.');
  updateOnboarding(c.settings, (s) => ({ ...s, profileConfirmedAt: nowMs(c) }));
}

export interface JobPreferencesInput {
  titles: string[];
  /** Country code (IN, US, GB, …). */
  country: string;
  states: string[];
  cities: string[];
  /** Further countries taken as a whole. */
  otherCountries: string[];
  remoteScope: Preferences['remoteScope'];
  workModes: string[];
  employmentTypes: string[];
  /** Expected salary (CTC) per year. */
  expectedSalary: number | null;
  currency: string;
  negotiable: boolean;
  noticePeriod: string | null;
  slider: number;
}

export type SavePreferencesResult = { ok: true } | { ok: false; errors: Partial<Record<keyof JobPreferencesInput, string>> };

const countryName = (code: string) => countryChoices().find((c) => c.code === code)?.name ?? null;
const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Saves the job preferences for matching, and the expected salary and notice period for applications. */
export function saveJobPreferences(c: OnboardingContext, input: JobPreferencesInput): SavePreferencesResult {
  const { profile, step } = onboardingStatus(c);
  if (!profile || step === 'ai' || step === 'cv' || step === 'review') throw new Error('Check your profile first.');
  const errors: Partial<Record<keyof JobPreferencesInput, string>> = {};
  const titles = clean(input.titles);
  const country = countryName(input.country);
  const workModes = input.workModes.filter((m): m is Preferences['workModes'][number] => (WORK_MODES as readonly string[]).includes(m));
  const employmentTypes = input.employmentTypes.filter((t): t is Preferences['employmentTypes'][number] => (EMPLOYMENT_TYPES as readonly string[]).includes(t));
  const currency = input.currency.trim().toUpperCase();
  if (!titles.length) errors.titles = 'Add at least one job title you want.';
  if (!country) errors.country = 'Choose the country you want to work in.';
  if (!workModes.length) errors.workModes = 'Choose remote, hybrid or on-site (at least one).';
  if (!employmentTypes.length) errors.employmentTypes = 'Choose at least one type of job.';
  if (!input.expectedSalary || !(input.expectedSalary > 0)) errors.expectedSalary = 'Enter your expected salary (CTC) per year.';
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Choose a currency.';
  if (!['none', 'country', 'worldwide'].includes(input.remoteScope)) errors.remoteScope = 'Choose which remote jobs to show.';
  if (!Number.isInteger(input.slider) || input.slider < SLIDER_MIN || input.slider > SLIDER_MAX) errors.slider = `Choose a level between ${SLIDER_MIN}% and ${SLIDER_MAX}%.`;
  if (Object.keys(errors).length) return { ok: false, errors };

  const others = clean(input.otherCountries).filter((code) => code !== input.country).map(countryName).filter((n): n is string => !!n);
  const locations = [...composeLocations(country!, clean(input.states), clean(input.cities)), ...others];
  const prefs: Preferences = {
    ...profile.preferences,
    targetTitles: titles,
    locations,
    remoteScope: input.remoteScope,
    workModes,
    employmentTypes,
    salaryMin: input.expectedSalary,
    salaryCurrency: currency,
    salaryNegotiable: input.negotiable,
  };
  c.profiles.updatePreferences(profile.id, prefs, input.slider);
  const notice = input.noticePeriod?.trim() || profile.data.application.noticePeriod;
  c.profiles.updateData(profile.id, { ...profile.data, application: { ...profile.data.application, expectedSalary: formatExpectedSalary(prefs), noticePeriod: notice } }, { byUser: true });
  updateOnboarding(c.settings, (s) => ({ ...s, preferencesConfirmedAt: nowMs(c) }));
  return { ok: true };
}

/** "Start job search": setup is done, discovery runs at the chosen interval, and jobs found so far get matched. */
export function startJobSearch(c: OnboardingContext, intervalMinutes: number): void {
  const { step, profile } = onboardingStatus(c);
  if (step !== 'start' || !profile) throw new Error('Finish the earlier steps first.');
  if (!isValidInterval(intervalMinutes)) throw new RangeError('Choose how often to look for jobs.');
  updateOnboarding(c.settings, (s) => ({ ...s, completedAt: nowMs(c) }));
  c.scheduler.setIntervalMinutes(intervalMinutes);
  c.scheduler.start();
  c.queue.enqueue(RESCORE_TASK, { profileId: profile.id }, { dedupeKey: `${RESCORE_TASK}:${profile.id}` });
}

const SLOW_READ_MS = 3 * 60_000;

/** Why setup may seem stuck while the CV is read: no worker to read it, or it is taking unusually long. */
export function cvWaitNotice(opts: { workerOnline: boolean; cv: { status: string; uploadedAt: Date } | null; now: Date }): string | null {
  if (!opts.workerOnline) return 'The background worker isn’t running, so your CV can’t be read and nothing can be searched. Start Job Scraper with `pnpm start` (or `pnpm dev`), then keep this page open.';
  const reading = opts.cv && (opts.cv.status === 'uploaded' || opts.cv.status === 'extracting');
  if (reading && opts.now.getTime() - opts.cv!.uploadedAt.getTime() > SLOW_READ_MS) return 'This is taking longer than usual. Check the terminal where Job Scraper runs for errors; the CV is read again if the worker restarts.';
  return null;
}

/** Where the user wants to work, read back from saved locations (as the pickers show them). */
function placesFrom(locations: string[]): Pick<JobPreferencesInput, 'country' | 'states' | 'cities' | 'otherCountries'> {
  const out = { country: '', states: [] as string[], cities: [] as string[], otherCountries: [] as string[] };
  for (const l of locations) {
    const p = resolvePlaces(l);
    const code = [...p.countries][0];
    if (!code) continue;
    const specific = p.cities.size > 0 || p.states.size > 0 || p.unknown.length > 0;
    if (!out.country && (specific || locations.length === 1)) out.country = code;
    if (code !== out.country) {
      if (!specific) out.otherCountries.push(code);
      continue;
    }
    if (p.cities.size) out.cities.push(...[...p.cities].map(displayPlace));
    else if (p.states.size) out.states.push(...[...p.states].map(displayPlace));
    else if (p.unknown.length) out.cities.push(...p.unknown);
  }
  if (!out.country && out.otherCountries.length) out.country = out.otherCountries.shift()!;
  return out;
}

/** What the preferences form starts with: earlier answers, else what the CV says. */
export function suggestedPreferences(profile: ProfileRecord): JobPreferencesInput {
  const { data, preferences: prefs } = profile;
  const titles = clean([...prefs.targetTitles, ...data.targetTitles]).length
    ? clean([...prefs.targetTitles, ...data.targetTitles])
    : clean([data.experience.find((e) => e.current)?.title ?? data.experience[0]?.title ?? '', data.headline ?? '']).slice(0, 2);
  const home = resolvePlaces([data.personal.location, data.personal.country].filter(Boolean).join(', '));
  const places = prefs.locations.length
    ? placesFrom(prefs.locations)
    : { country: [...home.countries][0] ?? '', states: [], cities: [...home.cities].map(displayPlace), otherCountries: [] };
  return {
    titles,
    ...places,
    remoteScope: prefs.remoteScope,
    workModes: prefs.workModes,
    employmentTypes: prefs.employmentTypes,
    expectedSalary: prefs.salaryMin,
    currency: prefs.salaryCurrency ?? currencyOf(places.country) ?? '',
    negotiable: prefs.salaryNegotiable ?? false,
    noticePeriod: data.application.noticePeriod,
    slider: profile.sliderValue,
  };
}
