/**
 * First-run setup (PRD §59, PLAN M10): the steps from install to a running job search, each worked out from what
 * is really saved, so progress survives restarts and other tabs. Nothing here is required to use the app; it only
 * guides a new user to their first match.
 */
import { z } from 'zod';
import { listSome, plural } from '../lib/format';
import type { Ai } from './ai';
import { AI_SETTINGS_KEY } from './ai/settings';
import { NOTIFICATION_SETTINGS_KEY } from './notifications/settings';
import type { ProfileService } from './profile/service';
import type { Scheduler } from './scheduler';
import type { SettingsStore } from './settings';
import type { SourceService } from './sources/service';

export interface OnboardingStep {
  id: 'ai' | 'cv' | 'preferences' | 'sources' | 'notifications' | 'start';
  title: string;
  /** What to do, or what was done. */
  detail: string;
  done: boolean;
  href: string;
}

export interface OnboardingDeps {
  settings: SettingsStore;
  profiles: ProfileService;
  sources: SourceService;
  scheduler: Scheduler;
  ai: Ai;
}

const saved = (settings: SettingsStore, key: string) => settings.get(key, z.unknown(), null) !== null;

export function onboardingSteps(deps: OnboardingDeps): { steps: OnboardingStep[]; complete: boolean; next: OnboardingStep | null } {
  const ai = deps.ai.status();
  const aiChosen = saved(deps.settings, AI_SETTINGS_KEY);
  const profiles = deps.profiles.list();
  const filled = (p: (typeof profiles)[number]) => p.data.experience.length + p.data.skills.length + p.data.education.length > 0;
  const titlesOf = (p: (typeof profiles)[number]) => [...p.preferences.targetTitles, ...p.data.targetTitles];
  // Any profile counts (a user may have set up a second one rather than the default).
  const profile = profiles.find((p) => filled(p) && titlesOf(p).length) ?? profiles.find(filled) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;
  const hasCv = !!profile && filled(profile);
  const titles = profiles.flatMap(titlesOf);
  const sources = deps.sources.list().filter((s) => s.enabled);
  const scheduler = deps.scheduler.getState();

  const steps: OnboardingStep[] = [
    {
      id: 'ai',
      title: 'Choose an AI provider (or none)',
      done: ai.configured || (aiChosen && ai.provider === 'none'),
      detail: ai.configured ? `Using ${ai.provider} (${ai.models.fast}).` : aiChosen && ai.provider === 'none' ? 'Working without AI: matching and CVs use offline rules.' : 'AI improves matching and tailoring. Add a key in .env, or choose "No AI" to work offline.',
      href: '/settings/ai',
    },
    {
      id: 'cv',
      title: 'Upload your CV',
      done: hasCv,
      detail: hasCv ? `Profile “${profile!.name}” has your experience and skills.` : 'Create a profile and upload your CV (PDF or Word); review what was read.',
      href: profile ? `/profiles/${profile.id}` : '/profiles',
    },
    {
      id: 'preferences',
      title: 'Say what jobs you want',
      done: titles.length > 0,
      detail: titles.length ? `Looking for: ${listSome([...new Set(titles)])}.` : 'Add the job titles you want, where, and how closely jobs must match.',
      href: profile ? `/profiles/${profile.id}#preferences` : '/profiles',
    },
    {
      id: 'sources',
      title: 'Pick where to look',
      done: sources.length > 0,
      detail: sources.length ? `${plural(sources.length, 'job source')} on.` : 'Turn on job sources, or add a company’s job board.',
      href: '/sources',
    },
    {
      id: 'notifications',
      title: 'Choose how you hear about matches',
      done: saved(deps.settings, NOTIFICATION_SETTINGS_KEY),
      detail: saved(deps.settings, NOTIFICATION_SETTINGS_KEY) ? 'Chosen; change it any time.' : 'In the app by default; add desktop, email or Telegram if you like.',
      href: '/settings/notifications',
    },
    {
      id: 'start',
      title: 'Start the job search',
      done: scheduler.enabled,
      detail: scheduler.enabled ? 'Job discovery is running.' : 'Start discovery: Job Scraper then checks for new jobs on its own.',
      href: '/settings/scheduling',
    },
  ];
  const next = steps.find((s) => !s.done) ?? null;
  return { steps, complete: !next, next };
}
