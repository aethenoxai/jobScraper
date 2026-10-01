/**
 * Scoring for the tailoring eval: which of a job's keywords the profile can back up ("evidenced"), and how many
 * of those appear in the parts of a CV a recruiter or ATS reads first (headline, summary, top skills, top bullets).
 */
import { mentions } from '../../src/server/matching/gates';
import type { JobRequirements } from '../../src/server/matching/analysis';
import { findSkills } from '../../src/server/matching/vocabulary';
import type { ProfileData } from '../../src/server/profile/model';
import type { TailoredCv } from '../../src/server/tailoring/model';

/** What a reader takes in first: the top few skills and the first bullet of each job. */
const TOP_SKILLS = 5;
const TOP_BULLETS = 1;

export function evidencedKeywords(profile: ProfileData, analysis: JobRequirements): string[] {
  const wanted = [...new Set([...analysis.skills, ...analysis.requirements.flatMap((r) => findSkills(r.text))])];
  const profileText = [
    ...profile.skills.map((s) => s.name),
    ...profile.experience.flatMap((e) => [e.title ?? '', e.summary ?? '', ...e.bullets.map((b) => b.text)]),
    ...profile.projects.flatMap((p) => [p.name, p.description ?? '', ...p.technologies, ...p.bullets.map((b) => b.text)]),
  ].join('\n');
  return wanted.filter((k) => mentions(profileText, k));
}

export function prominentMasterText(p: ProfileData): string {
  return [p.headline ?? '', p.summary ?? '', ...p.skills.slice(0, TOP_SKILLS).map((s) => s.name), ...p.experience.flatMap((e) => e.bullets.slice(0, TOP_BULLETS).map((b) => b.text))].join('\n');
}

export function prominentTailoredText(cv: TailoredCv): string {
  return [cv.headline ?? '', cv.summary ?? '', ...cv.skills.slice(0, TOP_SKILLS), ...cv.experience.flatMap((e) => e.bullets.slice(0, TOP_BULLETS).map((b) => b.text))].join('\n');
}

/** Share of keywords mentioned in the text (1 when there are none). */
export function coverage(keywords: string[], text: string): number {
  return keywords.length ? keywords.filter((k) => mentions(text, k)).length / keywords.length : 1;
}
