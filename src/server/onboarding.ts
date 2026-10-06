/**
 * First-run onboarding (PRD §7, §9, §59): AI model → CV → review the profile → what jobs to look for → start.
 * Nothing is searched and no app page opens until it is done. Each step is worked out from what is really saved,
 * so progress survives restarts and other tabs.
 */
import { z } from 'zod';
import type { Ai } from './ai';
import type { CvService, MasterCvRecord } from './profile/cv-service';
import type { ProfileRecord, ProfileService } from './profile/service';
import type { SettingsStore } from './settings';

export const ONBOARDING_KEY = 'onboarding';

export type OnboardingStep = 'ai' | 'cv' | 'review' | 'preferences' | 'start' | 'done';

const At = z.number().int().nullable().default(null);
const OnboardingStateSchema = z.object({
  /** The profile created from the CV uploaded during onboarding. */
  profileId: z.number().int().nullable().default(null),
  aiVerifiedAt: At,
  /** The user saw what was read from the CV and pressed Continue. */
  cvAcceptedAt: At,
  profileConfirmedAt: At,
  preferencesConfirmedAt: At,
  /** When the user pressed "Start job search". */
  completedAt: At,
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

const EMPTY: OnboardingState = { profileId: null, aiVerifiedAt: null, cvAcceptedAt: null, profileConfirmedAt: null, preferencesConfirmedAt: null, completedAt: null };

/** The saved state, or null on an install that never started onboarding. */
export function readOnboarding(settings: SettingsStore): OnboardingState | null {
  return settings.get(ONBOARDING_KEY, OnboardingStateSchema.nullable(), null);
}

export function updateOnboarding(settings: SettingsStore, fn: (s: OnboardingState) => OnboardingState): OnboardingState {
  return settings.update(ONBOARDING_KEY, OnboardingStateSchema, EMPTY, (s) => OnboardingStateSchema.parse(fn(s)));
}

const filled = (p: ProfileRecord) => p.data.experience.length + p.data.skills.length + p.data.education.length > 0;

/**
 * Onboarded: the user pressed Start and a profile exists. An install from before onboarding existed counts when it
 * already has a filled profile with target titles, so upgrading never locks anyone out.
 */
const setUpEarlier = (profiles: ProfileRecord[]) => profiles.some((p) => filled(p) && p.preferences.targetTitles.length + p.data.targetTitles.length > 0);

export function isOnboarded(deps: { settings: SettingsStore; profiles: Pick<ProfileService, 'list'> }): boolean {
  const state = readOnboarding(deps.settings);
  const profiles = deps.profiles.list();
  if (state) return state.completedAt !== null && profiles.length > 0;
  return setUpEarlier(profiles);
}

/**
 * An install set up before onboarding existed gets its record saved once (at start), so later edits (clearing the
 * target titles, a new CV) can't send it back to setup. Returns true when a record was saved.
 */
export function recordEarlierSetup(deps: { settings: SettingsStore; profiles: Pick<ProfileService, 'list'>; now?: () => Date }): boolean {
  if (readOnboarding(deps.settings)) return false;
  const profiles = deps.profiles.list();
  if (!setUpEarlier(profiles)) return false;
  const at = (deps.now ?? (() => new Date()))().getTime();
  const profile = profiles.find((p) => p.isDefault) ?? profiles[0];
  updateOnboarding(deps.settings, () => ({ profileId: profile.id, aiVerifiedAt: at, cvAcceptedAt: at, profileConfirmedAt: at, preferencesConfirmedAt: at, completedAt: at }));
  return true;
}

export interface OnboardingStatus {
  step: OnboardingStep;
  state: OnboardingState;
  /** The onboarding profile, once a CV was uploaded. */
  profile: ProfileRecord | null;
  /** Its latest CV. */
  cv: MasterCvRecord | null;
}

export function onboardingStatus(deps: { settings: SettingsStore; profiles: ProfileService; cvs: Pick<CvService, 'list'>; ai: Pick<Ai, 'taskStatus'> }): OnboardingStatus {
  const saved = readOnboarding(deps.settings);
  const profile = saved?.profileId != null ? deps.profiles.get(saved.profileId) : null;
  // Confirmations belong to the onboarding profile: without it they no longer count.
  const state: OnboardingState = saved ? (profile ? saved : { ...saved, profileId: null, cvAcceptedAt: null, profileConfirmedAt: null, preferencesConfirmedAt: null }) : EMPTY;
  const cv = profile ? (deps.cvs.list(profile.id)[0] ?? null) : null;
  const status = (step: OnboardingStep): OnboardingStatus => ({ step, state, profile, cv });

  if (isOnboarded(deps)) return status('done');
  if (state.aiVerifiedAt === null || !deps.ai.taskStatus('cv-extract').configured) return status('ai');
  const reading = cv?.status === 'uploaded' || cv?.status === 'extracting';
  if (!profile || reading || !(cv?.status === 'applied' || filled(profile)) || state.cvAcceptedAt === null) return status('cv');
  if (state.profileConfirmedAt === null) return status('review');
  if (state.preferencesConfirmedAt === null) return status('preferences');
  return status('start');
}
