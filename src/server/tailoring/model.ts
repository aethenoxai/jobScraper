import { z } from 'zod';

export const CV_SECTIONS = ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages'] as const;
export type CvSection = (typeof CV_SECTIONS)[number];

export const TailoredBulletSchema = z.object({
  text: z.string().trim().min(1).max(600),
  /** Master-profile bullet ids this bullet is based on (grounding). */
  sources: z.array(z.string()),
});

/**
 * A CV tailored for one job. It references master-profile items by id; facts such as employers, titles, dates,
 * degrees and contact details are always rendered from the master profile, never from this object.
 */
export const TailoredCvSchema = z.object({
  headline: z.string().trim().max(200).nullable(),
  summary: z.string().trim().max(1500).nullable(),
  skills: z.array(z.string().trim().min(1)).max(40),
  experience: z.array(z.object({ id: z.string(), bullets: z.array(TailoredBulletSchema) })),
  projects: z.array(z.object({ id: z.string(), bullets: z.array(TailoredBulletSchema) })),
  education: z.array(z.string()),
  certifications: z.array(z.string()),
  languages: z.array(z.string()),
  sectionOrder: z.array(z.enum(CV_SECTIONS)),
  /** Requirements of the job this CV emphasises. */
  targeted: z.array(z.string()),
  intensity: z.enum(['light', 'standard', 'deep']),
  method: z.enum(['ai', 'offline', 'edited']),
});
export type TailoredCv = z.infer<typeof TailoredCvSchema>;
export type TailoredBullet = z.infer<typeof TailoredBulletSchema>;

/** Years of experience as a CV says them: "5 years", or "over 4 years" for 4.4 (never a decimal). */
export function yearsPhrase(years: number): string {
  if (Number.isInteger(years)) return `${years} ${years === 1 ? 'year' : 'years'}`;
  return years < 1 ? 'under a year' : `over ${Math.floor(years)} ${Math.floor(years) === 1 ? 'year' : 'years'}`;
}

/** The most years a CV or letter may claim: the exact figure, or its rounding (4.6 → "5 years" is fair). */
export const maxClaimableYears = (years: number | null) => Math.max(years ?? 0, Math.round(years ?? 0));
