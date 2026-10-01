import type { ProfileData } from '../profile/model';
import { CV_SECTIONS, type TailoredCv } from './model';
import { sameSkill } from './validate';

export interface ChangeReport {
  method: TailoredCv['method'];
  intensity: TailoredCv['intensity'];
  targeted: string[];
  /** Parts replaced with your original wording because the generated text could not be verified. */
  repairs: number;
  headline: { before: string | null; after: string | null };
  summary: { before: string | null; after: string | null; changed: boolean };
  skills: { order: string[]; movedUp: string[]; omitted: string[] };
  /** "described": written from the role's own description rather than one of its lines. */
  experience: Array<{ id: string; title: string | null; company: string | null; bullets: Array<{ before: string[]; after: string; kind: 'unchanged' | 'reworded' | 'merged' | 'described' }>; omitted: string[] }>;
  projects: { included: string[]; omitted: string[] };
  /** The sections are in a different order than the standard one. */
  sectionsReordered: boolean;
  certificationsOmitted: string[];
}

/** "What was changed in the CV" (PRD §65): tailored CV compared with the master profile. */
export function buildChangeReport(profile: ProfileData, cv: TailoredCv, repairs: number): ChangeReport {
  const text = new Map(profile.experience.flatMap((e) => e.bullets.map((b) => [b.id, b.text] as const)).concat(profile.projects.flatMap((p) => p.bullets.map((b) => [b.id, b.text] as const))));
  const masterSkills = profile.skills.map((s) => s.name);
  const inMaster = (s: string) => masterSkills.some((m) => sameSkill(m, s));
  // Moves are judged among the skills both lists share, so leaving one out doesn't "move up" everything after it.
  const shared = cv.skills.filter(inMaster);
  const masterShared = masterSkills.filter((m) => shared.some((s) => sameSkill(m, s)));
  return {
    method: cv.method,
    intensity: cv.intensity,
    targeted: cv.targeted,
    repairs,
    headline: { before: profile.headline, after: cv.headline },
    summary: { before: profile.summary, after: cv.summary, changed: (profile.summary ?? '') !== (cv.summary ?? '') },
    skills: {
      order: cv.skills,
      movedUp: shared.filter((s, i) => masterShared.findIndex((m) => sameSkill(m, s)) > i),
      omitted: masterSkills.filter((m) => !cv.skills.some((s) => sameSkill(m, s))),
    },
    experience: cv.experience.map((item) => {
      const e = profile.experience.find((x) => x.id === item.id);
      const used = new Set(item.bullets.flatMap((b) => b.sources));
      return {
        id: item.id,
        title: e?.title ?? null,
        company: e?.company ?? null,
        bullets: item.bullets.map((b) => {
          const before = b.sources.map((s) => text.get(s)).filter((t): t is string => !!t);
          return { before, after: b.text, kind: before.length > 1 ? 'merged' : before.length === 0 ? 'described' : before[0] === b.text ? 'unchanged' : 'reworded' };
        }),
        omitted: (e?.bullets ?? []).filter((b) => !used.has(b.id)).map((b) => b.text),
      };
    }),
    projects: {
      included: cv.projects.map((p) => profile.projects.find((x) => x.id === p.id)?.name).filter((n): n is string => !!n),
      omitted: profile.projects.filter((p) => !cv.projects.some((x) => x.id === p.id)).map((p) => p.name),
    },
    sectionsReordered: cv.sectionOrder.join() !== CV_SECTIONS.filter((x) => cv.sectionOrder.includes(x)).join(),
    certificationsOmitted: profile.certifications.filter((c) => !cv.certifications.includes(c.id)).map((c) => c.name),
  };
}
