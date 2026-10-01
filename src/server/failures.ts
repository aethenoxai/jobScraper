/**
 * Failure codes (PRD §51) and what they mean for the user. Job Scraper records more specific codes in places
 * (SOURCE_PARSE, NO_CONFIRMATION…); each maps to one of the PRD's codes and comes with a plain explanation and the
 * next step. Problems that don't belong to one application or source are kept in a short log for the System page.
 */
import { z } from 'zod';
import { scrubSecrets } from './logging';
import type { SettingsStore } from './settings';

export const PRD_FAILURE_CODES = [
  'JOB_DISCOVERY_FAILED',
  'JOB_PARSE_FAILED',
  'MATCHING_FAILED',
  'CV_GENERATION_FAILED',
  'EMAIL_FAILED',
  'BROWSER_APPLICATION_FAILED',
  'SOURCE_UNAVAILABLE',
  'CAPTCHA_DETECTED',
  'MFA_REQUIRED',
  'UNSUPPORTED_APPLICATION_FLOW',
] as const;
export type PrdFailureCode = (typeof PRD_FAILURE_CODES)[number];

interface FailureInfo {
  prd: PrdFailureCode;
  title: string;
  help: string;
}

const INFO: Record<string, FailureInfo> = {
  JOB_DISCOVERY_FAILED: { prd: 'JOB_DISCOVERY_FAILED', title: 'Job discovery failed', help: 'No job source could be read in this scan. Check your internet connection, then the Job sources page for each source’s error.' },
  JOB_PARSE_FAILED: { prd: 'JOB_PARSE_FAILED', title: 'Some jobs couldn’t be read', help: 'A source returned listings Job Scraper couldn’t read; the others were kept. If it keeps happening, the site may have changed.' },
  SOURCE_PARSE: { prd: 'JOB_PARSE_FAILED', title: 'The source’s answer couldn’t be read', help: 'The site may have changed its format. The source is tried again on the next scan.' },
  MATCHING_FAILED: { prd: 'MATCHING_FAILED', title: 'A job couldn’t be scored', help: 'Other jobs were still matched. The job is tried again later; check the AI provider page if this repeats.' },
  CV_GENERATION_FAILED: { prd: 'CV_GENERATION_FAILED', title: 'The tailored CV couldn’t be prepared', help: 'Open the application and choose “Try again”. The reason is shown there.' },
  EMAIL_FAILED: { prd: 'EMAIL_FAILED', title: 'The application email wasn’t sent', help: 'The mail server refused it. Check Settings → Email, then send again from the application.' },
  BROWSER_APPLICATION_FAILED: { prd: 'BROWSER_APPLICATION_FAILED', title: 'Applying on the website failed', help: 'Apply on the site yourself, then mark the application as applied.' },
  BROWSER_ERROR: { prd: 'BROWSER_APPLICATION_FAILED', title: 'The browser couldn’t complete the application', help: 'Nothing was submitted. Try again later, or apply on the site yourself.' },
  NO_CONFIRMATION: { prd: 'BROWSER_APPLICATION_FAILED', title: 'Submitted, but not confirmed', help: 'The form may have been sent. Check your email or the site before applying again.' },
  LOGIN_REQUIRED: { prd: 'BROWSER_APPLICATION_FAILED', title: 'The site needs you to sign in', help: 'Sign in once in Settings → Browser, then apply again. Nothing was submitted.' },
  SOURCE_UNAVAILABLE: { prd: 'SOURCE_UNAVAILABLE', title: 'The job source is unavailable', help: 'The site didn’t answer or returned an error. It is tried again on the next scan.' },
  SOURCE_CONFIG: { prd: 'SOURCE_UNAVAILABLE', title: 'The source’s settings are invalid', help: 'Fix the source’s settings on the Job sources page.' },
  SOURCE_BLOCKED: { prd: 'SOURCE_UNAVAILABLE', title: 'The source refused access', help: 'The site doesn’t allow automated reading. Disable this source or use another one.' },
  SOURCE_RATE_LIMITED: { prd: 'SOURCE_UNAVAILABLE', title: 'The source asked to slow down', help: 'Job Scraper waits as long as the site asked before trying again.' },
  CAPTCHA_DETECTED: { prd: 'CAPTCHA_DETECTED', title: 'The site showed a CAPTCHA', help: 'Job Scraper never solves CAPTCHAs. Nothing was submitted; apply on the site yourself.' },
  MFA_REQUIRED: { prd: 'MFA_REQUIRED', title: 'The site asked for a verification code', help: 'Job Scraper never enters codes. Nothing was submitted; apply on the site yourself.' },
  UNSUPPORTED_APPLICATION_FLOW: { prd: 'UNSUPPORTED_APPLICATION_FLOW', title: 'A form Job Scraper can’t complete truthfully', help: 'Nothing was submitted. The reason names the question or step; apply on the site yourself.' },
};

export function describeFailure(code: string): FailureInfo & { code: string } {
  return { code, ...(INFO[code] ?? { prd: 'BROWSER_APPLICATION_FAILED', title: code.replaceAll('_', ' ').toLowerCase(), help: 'See the reason shown with it.' }) };
}

const LOG_KEY = 'failures.recent';
const MAX_ENTRIES = 50;
const EntrySchema = z.object({ code: z.string(), message: z.string(), context: z.string().nullable(), at: z.number() });
export type FailureEntry = z.infer<typeof EntrySchema>;

/** Problems that belong to no single application or source (a whole scan, matching a job…), newest first. */
export function createFailureLog(settings: SettingsStore, now: () => Date = () => new Date()) {
  return {
    record(code: PrdFailureCode, message: string, context?: string): void {
      const entry: FailureEntry = { code, message: scrubSecrets(message).slice(0, 500), context: context?.slice(0, 200) ?? null, at: now().getTime() };
      settings.update(LOG_KEY, z.array(EntrySchema), [], (list) => [entry, ...list].slice(0, MAX_ENTRIES));
    },
    recent(): FailureEntry[] {
      return settings.get(LOG_KEY, z.array(EntrySchema), []);
    },
  };
}

export type FailureLog = ReturnType<typeof createFailureLog>;
