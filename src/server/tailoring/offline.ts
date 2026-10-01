import type { JobRequirements } from '../matching/analysis';
import { mentions } from '../matching/gates';
import type { TailoringIntensity } from '../matching/slider';
import { findSkills } from '../matching/vocabulary';
import type { ProfileData } from '../profile/model';
import { CV_SECTIONS, yearsPhrase, type CvSection, type TailoredCv } from './model';

/** Words and skills of the job that the CV should emphasise. */
export function jobTerms(analysis: JobRequirements): string[] {
  return [...new Set([...analysis.skills, ...analysis.requirements.flatMap((r) => findSkills(r.text))])];
}

export function relevance(text: string, terms: string[]): number {
  return terms.reduce((n, term) => n + (mentions(text, term) ? 1 : 0), 0);
}

/** Stable sort by descending score (ties keep their original order). */
const byRelevance = <T>(items: T[], score: (t: T) => number): T[] =>
  items
    .map((item, i) => ({ item, i, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);

const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function sectionOrderFor(profile: ProfileData): CvSection[] {
  const earlyCareer = (profile.yearsExperience ?? 0) < 2 && profile.education.length > 0;
  return earlyCareer ? ['summary', 'skills', 'education', 'projects', 'experience', 'certifications', 'languages'] : [...CV_SECTIONS];
}

/**
 * Tailoring without AI: reorders and selects, never rewrites. Every bullet is copied verbatim from the master
 * profile, so the result is grounded by construction (N3).
 */
export function offlineTailor(profile: ProfileData, analysis: JobRequirements, intensity: TailoringIntensity): TailoredCv {
  const terms = jobTerms(analysis);
  const skillScore = (name: string) => {
    const idx = terms.findIndex((t) => t.toLowerCase() === name.toLowerCase());
    return idx === -1 ? (relevance(name, terms) ? 1 : 0) : 1000 - idx;
  };
  const skills = byRelevance(profile.skills.map((s) => s.name), skillScore).slice(0, 25);
  const reorderBullets = intensity !== 'light';
  const maxBullets = intensity === 'deep' ? 6 : 99;

  const experience = profile.experience.map((e) => {
    const bullets = reorderBullets ? byRelevance(e.bullets, (b) => relevance(b.text, terms)) : e.bullets;
    return { id: e.id, bullets: bullets.slice(0, maxBullets).map((b) => ({ text: b.text, sources: [b.id] })) };
  });
  const projectScore = (p: ProfileData['projects'][number]) => relevance([p.name, p.description ?? '', ...p.technologies, ...p.bullets.map((b) => b.text)].join(' '), terms);
  const projects = byRelevance(profile.projects, projectScore)
    .filter((p, i) => intensity !== 'deep' || projectScore(p) > 0 || i < 2)
    .slice(0, 4)
    .map((p) => ({ id: p.id, bullets: (reorderBullets ? byRelevance(p.bullets, (b) => relevance(b.text, terms)) : p.bullets).map((b) => ({ text: b.text, sources: [b.id] })) }));

  const matchedSkills = skills.filter((s) => skillScore(s) > 0).slice(0, 4);
  const summary =
    profile.summary ??
    (profile.headline
      ? `${profile.headline}${profile.yearsExperience ? ` with ${yearsPhrase(profile.yearsExperience)} of experience` : ''}${matchedSkills.length ? ` in ${listJoin(matchedSkills)}` : ''}.`
      : null);

  return {
    headline: profile.headline,
    summary,
    skills,
    experience,
    projects,
    education: profile.education.map((e) => e.id),
    certifications: byRelevance(profile.certifications, (c) => relevance(c.name, [...terms, ...analysis.requirements.map((r) => r.text)])).map((c) => c.id),
    languages: profile.languages.map((l) => l.id),
    sectionOrder: sectionOrderFor(profile),
    targeted: analysis.requirements.filter((r) => r.mandatory && findSkills(r.text).some((s) => skills.some((k) => k.toLowerCase() === s.toLowerCase()))).map((r) => r.text),
    intensity,
    method: 'offline',
  };
}
