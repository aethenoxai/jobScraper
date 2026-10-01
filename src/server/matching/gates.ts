/** Deterministic checks that run before any AI: cheap, explainable, and they keep AI spend bounded. */
import { listSome } from '../../lib/format';
import { normalizeCompany, normalizeTitle } from '../jobs/normalize';
import type { Preferences, ProfileData } from '../profile/model';
import { locationMatches } from './geo';

export interface GateJob {
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  employmentType: string | null;
  status: string;
  description: string;
}

export interface GateProfile {
  data: ProfileData;
  preferences: Preferences;
}

export interface GateResult {
  pass: boolean;
  reason?: string;
  /** How well the job title fits the user's target roles (0–1). */
  titleFit: number;
  /** How well the location fits (1 exact, 0.8 same country, 0.6 unknown). */
  locationFit: number;
}

/** Words that describe level rather than role; ignored when comparing titles. */
const LEVEL_WORDS = new Set(['senior', 'junior', 'lead', 'principal', 'staff', 'head', 'chief', 'i', 'ii', 'iii', 'iv', 'associate', 'entry', 'level', 'mid', 'intermediate', 'experienced', 'remote', 'hybrid', 'of', 'and', 'the', 'for', 'with', 'to', 'in']);
/** Spellings and abbreviations of the same role (only for comparing titles; dedupe fingerprints stay as they are). */
const TITLE_SYNONYMS: Array<[RegExp, string]> = [
  [/\bfront ?end\b/g, 'frontend'],
  [/\bback ?end\b/g, 'backend'],
  [/\bfullstack\b/g, 'full stack'],
  [/\b(?:developer|programmer)\b/g, 'engineer'],
  [/\b(?:sde|swe)\b/g, 'software engineer'],
  [/\brn\b/g, 'registered nurse'],
  [/\bae\b/g, 'account executive'],
  [/\bmaths?\b/g, 'mathematics'],
];
function titleWords(t: string): string[] {
  let n = normalizeTitle(t);
  for (const [re, to] of TITLE_SYNONYMS) n = n.replace(re, to);
  return n.split(' ').filter((w) => w && !LEVEL_WORDS.has(w));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whole-word, case-insensitive containment ("go" must not match "Golang"). Terms of one or two letters only
 * count where the text writes them with a capital ("Go", "IT"), not as everyday words ("we go", "make it").
 */
export function mentions(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])${escapeRe(t)}(?![\\p{L}\\p{N}+#])`, 'giu');
  if (t.length > 2) return re.test(text);
  return [...text.matchAll(re)].some((m) => m[0] !== m[0].toLowerCase());
}

/** Best overlap between the job title and any target title (share of the target's role words found). */
export function titleFit(jobTitle: string, targets: string[]): number {
  const job = new Set(titleWords(jobTitle));
  let best = 0;
  for (const target of targets) {
    const words = titleWords(target);
    if (!words.length) continue;
    const hit = words.filter((w) => job.has(w)).length / words.length;
    best = Math.max(best, hit);
  }
  return Math.round(best * 100) / 100;
}

export function targetTitles(p: GateProfile): string[] {
  const explicit = [...p.preferences.targetTitles, ...p.data.targetTitles];
  if (explicit.length) return explicit;
  return [p.data.headline, ...p.data.previousTitles].filter((t): t is string => !!t);
}

const fail = (reason: string): GateResult => ({ pass: false, reason, titleFit: 0, locationFit: 0 });

export function applyGates(job: GateJob, profile: GateProfile): GateResult {
  const prefs = profile.preferences;
  const text = `${job.title}\n${job.description}`;
  if (job.status !== 'active') return fail('The job is no longer listed');

  const company = normalizeCompany(job.company);
  // Whole normalised words ("ey", "hp"): mentions() needs capitals for 1–2 letter terms, which normalising removed.
  const excluded = prefs.excludedCompanies.find((c) => normalizeCompany(c) && ` ${company} `.includes(` ${normalizeCompany(c)} `));
  if (excluded) return fail(`Excluded company (${excluded})`);

  const banned = prefs.excludeKeywords.find((k) => mentions(text, k));
  if (banned) return fail(`Mentions "${banned}", which you excluded`);
  if (prefs.includeKeywords.length && !prefs.includeKeywords.some((k) => mentions(text, k))) {
    return fail(`Doesn't mention any of: ${prefs.includeKeywords.join(', ')}`);
  }

  if (job.employmentType && prefs.employmentTypes.length && !prefs.employmentTypes.includes(job.employmentType as never)) {
    return fail(`It's ${/^[aeiou]/i.test(job.employmentType) ? 'an' : 'a'} ${job.employmentType} role`);
  }
  if (job.workMode && prefs.workModes.length && !prefs.workModes.includes(job.workMode as never)) {
    return fail(`It's ${job.workMode}, and you chose ${prefs.workModes.join('/')}`);
  }

  const loc = locationMatches(job.location, job.workMode, prefs);
  if (!loc.ok) return fail(loc.reason ?? 'Location does not match');

  const targets = targetTitles(profile);
  let fit = targets.length ? titleFit(job.title, targets) : 0.5;
  if (targets.length && fit === 0) {
    // A differently named role can still fit if it asks for several of the user's skills.
    const skillHits = profile.data.skills.filter((s) => mentions(text, s.name)).length;
    if (skillHits < 3) return fail(`The title doesn't match your target roles (${listSome(targets)})`);
    fit = 0.3;
  }
  return { pass: true, titleFit: fit, locationFit: loc.fit };
}
