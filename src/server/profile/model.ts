import { z } from 'zod';

/** 'YYYY-MM' or 'YYYY'. Kept as text so partial dates from CVs survive. */
const PartialDate = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'Use YYYY or YYYY-MM');
const Text = z.string().trim().min(1);
const nullableText = Text.nullable();

export const BulletSchema = z.object({ id: z.string(), text: Text });

export const ExperienceSchema = z.object({
  id: z.string(),
  title: nullableText,
  company: nullableText,
  location: nullableText,
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
  current: z.boolean(),
  summary: nullableText,
  bullets: z.array(BulletSchema),
});

export const EducationSchema = z.object({
  id: z.string(),
  institution: nullableText,
  degree: nullableText,
  field: nullableText,
  startDate: PartialDate.nullable(),
  endDate: PartialDate.nullable(),
  grade: nullableText,
});

export const CertificationSchema = z.object({ id: z.string(), name: Text, issuer: nullableText, date: PartialDate.nullable() });

export const SKILL_CATEGORIES = ['skill', 'technology', 'tool', 'soft'] as const;
export const SkillSchema = z.object({ id: z.string(), name: Text, category: z.enum(SKILL_CATEGORIES) });

export const ProjectSchema = z.object({
  id: z.string(),
  name: Text,
  description: nullableText,
  url: nullableText,
  technologies: z.array(Text),
  bullets: z.array(BulletSchema),
});

export const LanguageSchema = z.object({ id: z.string(), name: Text, proficiency: nullableText });
export const LinkSchema = z.object({ id: z.string(), label: Text, url: Text });

export const CAREER_LEVELS = ['student', 'entry', 'junior', 'mid', 'senior', 'lead', 'manager', 'director', 'executive'] as const;

export const ProfileDataSchema = z.object({
  personal: z.object({
    fullName: nullableText,
    email: nullableText,
    phone: nullableText,
    location: nullableText,
    country: nullableText,
    timezone: nullableText,
    links: z.array(LinkSchema),
  }),
  headline: nullableText,
  previousTitles: z.array(Text),
  targetTitles: z.array(Text),
  summary: nullableText,
  industry: nullableText,
  domain: nullableText,
  yearsExperience: z.number().min(0).max(70).nullable(),
  careerLevel: z.enum(CAREER_LEVELS).nullable(),
  experience: z.array(ExperienceSchema),
  education: z.array(EducationSchema),
  certifications: z.array(CertificationSchema),
  skills: z.array(SkillSchema),
  projects: z.array(ProjectSchema),
  languages: z.array(LanguageSchema),
  application: z.object({
    workAuthorization: nullableText,
    visaStatus: nullableText,
    noticePeriod: nullableText,
    relocation: z.boolean().nullable(),
    travel: z.boolean().nullable(),
    currentlyEmployed: z.boolean().nullable(),
    currentSalary: nullableText,
    expectedSalary: nullableText,
  }),
});
export type ProfileData = z.infer<typeof ProfileDataSchema>;

export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'temporary'] as const;

export const PreferencesSchema = z.object({
  targetTitles: z.array(Text),
  /** Free-text places: cities, regions, countries ("Bangalore", "India", "United Kingdom"). */
  locations: z.array(Text),
  /** Accept remote jobs open to the user's country/region, or worldwide. */
  remoteScope: z.enum(['none', 'country', 'worldwide']),
  workModes: z.array(z.enum(WORK_MODES)),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)),
  salaryMin: z.number().min(0).nullable(),
  salaryCurrency: z.string().trim().length(3).nullable(),
  includeKeywords: z.array(Text),
  excludeKeywords: z.array(Text),
  excludedCompanies: z.array(Text),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  targetTitles: [],
  locations: [],
  remoteScope: 'country',
  workModes: ['remote', 'hybrid', 'onsite'],
  employmentTypes: ['full-time'],
  salaryMin: null,
  salaryCurrency: null,
  includeKeywords: [],
  excludeKeywords: [],
  excludedCompanies: [],
};

export const SLIDER_MIN = 70;
export const SLIDER_MAX = 200;
export const DEFAULT_SLIDER = 100;

/**
 * Reads a stored profile that no longer fits the schema (an older version, a manual edit): every field and list item
 * that is still valid is kept, the rest is reported, so nothing readable disappears from view.
 */
export function salvageProfileData(raw: unknown): { data: ProfileData; issues: string[] } {
  const full = ProfileDataSchema.safeParse(raw);
  if (full.success) return { data: full.data, issues: [] };
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...emptyProfile() };
  const issues: string[] = [];
  for (const [key, schema] of Object.entries(ProfileDataSchema.shape) as Array<[string, z.ZodType]>) {
    if (!(key in stored)) continue;
    const field = schema.safeParse(stored[key]);
    if (field.success) {
      out[key] = field.data;
      continue;
    }
    const value = stored[key];
    if (schema instanceof z.ZodArray && Array.isArray(value)) {
      const kept = value.map((item) => (schema.element as z.ZodType).safeParse(item)).filter((r) => r.success).map((r) => r.data);
      out[key] = kept;
      issues.push(`${key}: ${value.length - kept.length} item(s) couldn't be read`);
    } else {
      issues.push(`${key} couldn't be read`);
    }
  }
  const result = ProfileDataSchema.safeParse(out);
  return result.success ? { data: result.data, issues } : { data: emptyProfile(), issues: ['the profile couldn\'t be read'] };
}

export function emptyProfile(): ProfileData {
  return {
    personal: { fullName: null, email: null, phone: null, location: null, country: null, timezone: null, links: [] },
    headline: null,
    previousTitles: [],
    targetTitles: [],
    summary: null,
    industry: null,
    domain: null,
    yearsExperience: null,
    careerLevel: null,
    experience: [],
    education: [],
    certifications: [],
    skills: [],
    projects: [],
    languages: [],
    application: {
      workAuthorization: null,
      visaStatus: null,
      noticePeriod: null,
      relocation: null,
      travel: null,
      currentlyEmployed: null,
      currentSalary: null,
      expectedSalary: null,
    },
  };
}

const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
const ensure = <T extends { id: string }>(item: T, prefix: string): T => (item.id ? item : { ...item, id: newId(prefix) });

/** Gives every list item and bullet an id (keeping existing ones). Ids let tailored CVs cite their source. */
export function assignIds(p: ProfileData): ProfileData {
  return {
    ...p,
    personal: { ...p.personal, links: p.personal.links.map((l) => ensure(l, 'lnk')) },
    experience: p.experience.map((e) => ({ ...ensure(e, 'exp'), bullets: e.bullets.map((b) => ensure(b, 'bul')) })),
    education: p.education.map((e) => ensure(e, 'edu')),
    certifications: p.certifications.map((c) => ensure(c, 'crt')),
    skills: p.skills.map((s) => ensure(s, 'skl')),
    projects: p.projects.map((pr) => ({ ...ensure(pr, 'prj'), bullets: pr.bullets.map((b) => ensure(b, 'bul')) })),
    languages: p.languages.map((l) => ensure(l, 'lng')),
  };
}

function monthIndex(date: string, endOfYear: boolean): number {
  const [y, m] = date.split('-').map(Number);
  return y * 12 + (m ? m - 1 : endOfYear ? 11 : 0);
}

/** Total years across jobs with known dates, overlapping periods counted once. Null when nothing is computable. */
export function computeYearsOfExperience(p: ProfileData, now: Date = new Date()): number | null {
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const intervals = p.experience
    .filter((e) => e.startDate && (e.endDate || e.current))
    .map((e) => [monthIndex(e.startDate!, false), e.endDate ? monthIndex(e.endDate, true) : nowIdx] as const)
    .filter(([s, e]) => e >= s)
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) return null;
  let months = 0;
  let [curS, curE] = intervals[0];
  for (const [s, e] of intervals.slice(1)) {
    if (s <= curE) curE = Math.max(curE, e);
    else {
      months += curE - curS;
      [curS, curE] = [s, e];
    }
  }
  months += curE - curS;
  return Math.round((months / 12) * 10) / 10;
}

const IMPORTANT_FIELDS: Array<[string, (p: ProfileData) => unknown]> = [
  ['personal.fullName', (p) => p.personal.fullName],
  ['personal.email', (p) => p.personal.email],
  ['personal.phone', (p) => p.personal.phone],
  ['personal.location', (p) => p.personal.location],
  ['headline', (p) => p.headline],
  ['summary', (p) => p.summary],
  ['yearsExperience', (p) => p.yearsExperience],
  ['experience', (p) => (p.experience.length ? p.experience : null)],
  ['education', (p) => (p.education.length ? p.education : null)],
  ['skills', (p) => (p.skills.length ? p.skills : null)],
  ['application.workAuthorization', (p) => p.application.workAuthorization],
  ['application.noticePeriod', (p) => p.application.noticePeriod],
  ['application.expectedSalary', (p) => p.application.expectedSalary],
];

/** Important fields the user should fill in by hand (never guessed). */
export function missingFields(p: ProfileData): string[] {
  return IMPORTANT_FIELDS.filter(([, get]) => get(p) === null || get(p) === undefined).map(([path]) => path);
}

const validDate = (d: string | null) => (d && /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(d) ? d : null);
const nonEmpty = <T extends { text: string }>(list: T[]) => list.filter((b) => b.text.trim().length > 0);

/** Drops or repairs anything that would fail validation (empty bullets, bad dates, nameless items). */
export function sanitizeProfile(p: ProfileData): ProfileData {
  const keep = <T>(schema: z.ZodType<T>, list: T[]) => list.filter((x) => schema.safeParse(x).success);
  return {
    ...p,
    experience: keep(
      ExperienceSchema,
      p.experience.map((e) => ({ ...e, startDate: validDate(e.startDate), endDate: validDate(e.endDate), bullets: nonEmpty(e.bullets) })),
    ),
    education: keep(EducationSchema, p.education.map((e) => ({ ...e, startDate: validDate(e.startDate), endDate: validDate(e.endDate) }))),
    certifications: keep(CertificationSchema, p.certifications.map((c) => ({ ...c, date: validDate(c.date) }))),
    skills: keep(SkillSchema, p.skills),
    projects: keep(ProjectSchema, p.projects.map((pr) => ({ ...pr, technologies: pr.technologies.filter((x) => x.trim()), bullets: nonEmpty(pr.bullets) }))),
    languages: keep(LanguageSchema, p.languages),
    personal: { ...p.personal, links: keep(LinkSchema, p.personal.links) },
    previousTitles: p.previousTitles.filter((x) => x.trim()),
    targetTitles: p.targetTitles.filter((x) => x.trim()),
  };
}
