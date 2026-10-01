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
  profileConfirmedAt: At,
  preferencesConfirmedAt: At,
  /** When the user pressed "Start job search". */
  completedAt: At,
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

const EMPTY: OnboardingState = { profileId: null, aiVerifiedAt: null, profileConfirmedAt: null, preferencesConfirmedAt: null, completedAt: null };

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
export function isOnboarded(deps: { settings: SettingsStore; profiles: Pick<ProfileService, 'list'> }): boolean {
  const state = readOnboarding(deps.settings);
  const profiles = deps.profiles.list();
  if (state) return state.completedAt !== null && profiles.length > 0;
  return profiles.some((p) => filled(p) && p.preferences.targetTitles.length + p.data.targetTitles.length > 0);
}

export interface OnboardingStatus {
  step: OnboardingStep;
  state: OnboardingState;
  /** The onboarding profile, once a CV was uploaded. */
  profile: ProfileRecord | null;
  /** Its latest CV. */
  cv: MasterCvRecord | null;
}

export function onboardingStatus(deps: { settings: SettingsStore; profiles: ProfileService; cvs: Pick<CvService, 'list'>; ai: Pick<Ai, 'status'> }): OnboardingStatus {
  const saved = readOnboarding(deps.settings);
  const profile = saved?.profileId != null ? deps.profiles.get(saved.profileId) : null;
  // Confirmations belong to the onboarding profile: without it they no longer count.
  const state: OnboardingState = saved ? (profile ? saved : { ...saved, profileId: null, profileConfirmedAt: null, preferencesConfirmedAt: null }) : EMPTY;
  const cv = profile ? (deps.cvs.list(profile.id)[0] ?? null) : null;
  const status = (step: OnboardingStep): OnboardingStatus => ({ step, state, profile, cv });

  if (isOnboarded(deps)) return status('done');
  if (state.aiVerifiedAt === null || !deps.ai.status().configured) return status('ai');
  const reading = cv?.status === 'uploaded' || cv?.status === 'extracting';
  if (!profile || reading || !(cv?.status === 'applied' || filled(profile))) return status('cv');
  if (state.profileConfirmedAt === null) return status('review');
  if (state.preferencesConfirmedAt === null) return status('preferences');
  return status('start');
}
