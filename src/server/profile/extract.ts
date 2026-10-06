import { z } from 'zod';
import { CV_EXTRACT_MODEL, type Ai } from '../ai';
import { scrubSecrets } from '../logging';
import { heuristicExtract, toPartialDate } from './heuristic';
import { assignIds, CAREER_LEVELS, computeYearsOfExperience, emptyProfile, ProfileDataSchema, SKILL_CATEGORIES, type ProfileData } from './model';

/** What the model returns. Every field is nullable (not optional) for structured-output compatibility. */
const s = z.string().nullable();
export const AiExtractionSchema = z.object({
  personal: z.object({
    fullName: s,
    email: s,
    phone: s,
    location: s,
    country: s,
    timezone: s,
    links: z.array(z.object({ label: z.string(), url: z.string() })),
  }),
  headline: s,
  previousTitles: z.array(z.string()),
  summary: s,
  industry: s,
  domain: s,
  yearsExperience: z.number().nullable(),
  careerLevel: z.enum(CAREER_LEVELS).nullable(),
  experience: z.array(
    z.object({ title: s, company: s, location: s, startDate: s, endDate: s, current: z.boolean(), summary: s, bullets: z.array(z.string()) }),
  ),
  education: z.array(z.object({ institution: s, degree: s, field: s, startDate: s, endDate: s, grade: s })),
  certifications: z.array(z.object({ name: z.string(), issuer: s, date: s })),
  skills: z.array(z.object({ name: z.string(), category: z.enum(SKILL_CATEGORIES) })),
  projects: z.array(z.object({ name: z.string(), description: s, url: s, technologies: z.array(z.string()), bullets: z.array(z.string()) })),
  languages: z.array(z.object({ name: z.string(), proficiency: s })),
  application: z.object({
    workAuthorization: s,
    visaStatus: s,
    noticePeriod: s,
    relocation: z.boolean().nullable(),
    travel: z.boolean().nullable(),
    currentlyEmployed: z.boolean().nullable(),
    currentSalary: s,
    expectedSalary: s,
  }),
});
export type AiExtraction = z.infer<typeof AiExtractionSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `You extract a structured professional profile from the text of a CV/resume.
Rules:
- Copy facts exactly as written in the CV. Never invent, infer or embellish anything.
- If a field is not explicitly present in the CV, return null (or an empty list).
- Do not guess salary, notice period, work authorization, visa status, relocation or travel unless the CV states them.
- Dates: use "YYYY-MM" when month and year are given, "YYYY" when only the year is given. Set current=true and endDate=null for ongoing roles.
- bullets: one entry per achievement/responsibility line, copied verbatim without the bullet symbol.
- skills: list each skill/technology/tool once; category is skill, technology, tool or soft.
- careerLevel: only if clearly implied by titles (e.g. "Senior", "Lead", "Intern"); otherwise null.`;

export interface ExtractionResult {
  data: ProfileData;
  method: 'ai' | 'heuristic';
  warnings: string[];
}

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const date = (v: string | null): string | null => {
  const t = clean(v);
  if (!t) return null;
  if (/^\d{4}(-\d{2})?$/.test(t)) return t;
  return toPartialDate(t);
};
const texts = (list: string[]) => list.map((x) => x.trim()).filter(Boolean);

function fromAi(a: AiExtraction): ProfileData {
  const p = emptyProfile();
  p.personal = {
    fullName: clean(a.personal.fullName),
    email: clean(a.personal.email),
    phone: clean(a.personal.phone),
    location: clean(a.personal.location),
    country: clean(a.personal.country),
    timezone: clean(a.personal.timezone),
    links: a.personal.links.filter((l) => clean(l.url)).map((l) => ({ id: '', label: clean(l.label) ?? 'Link', url: l.url.trim() })),
  };
  p.headline = clean(a.headline);
  p.previousTitles = texts(a.previousTitles);
  p.summary = clean(a.summary);
  p.industry = clean(a.industry);
  p.domain = clean(a.domain);
  p.yearsExperience = a.yearsExperience !== null && a.yearsExperience >= 0 && a.yearsExperience <= 70 ? a.yearsExperience : null;
  p.careerLevel = a.careerLevel;
  p.experience = a.experience.map((e) => ({
    id: '',
    title: clean(e.title),
    company: clean(e.company),
    location: clean(e.location),
    startDate: date(e.startDate),
    endDate: e.current ? null : date(e.endDate),
    current: e.current,
    summary: clean(e.summary),
    bullets: texts(e.bullets).map((text) => ({ id: '', text })),
  }));
  p.education = a.education.map((e) => ({
    id: '',
    institution: clean(e.institution),
    degree: clean(e.degree),
    field: clean(e.field),
    startDate: date(e.startDate),
    endDate: date(e.endDate),
    grade: clean(e.grade),
  }));
  p.certifications = a.certifications.filter((c) => clean(c.name)).map((c) => ({ id: '', name: c.name.trim(), issuer: clean(c.issuer), date: date(c.date) }));
  const seen = new Set<string>();
  p.skills = a.skills
    .filter((sk) => clean(sk.name) && !seen.has(sk.name.trim().toLowerCase()) && seen.add(sk.name.trim().toLowerCase()))
    .map((sk) => ({ id: '', name: sk.name.trim(), category: sk.category }));
  p.projects = a.projects
    .filter((pr) => clean(pr.name))
    .map((pr) => ({ id: '', name: pr.name.trim(), description: clean(pr.description), url: clean(pr.url), technologies: texts(pr.technologies), bullets: texts(pr.bullets).map((text) => ({ id: '', text })) }));
  p.languages = a.languages.filter((l) => clean(l.name)).map((l) => ({ id: '', name: l.name.trim(), proficiency: clean(l.proficiency) }));
  p.application = {
    workAuthorization: clean(a.application.workAuthorization),
    visaStatus: clean(a.application.visaStatus),
    noticePeriod: clean(a.application.noticePeriod),
    relocation: a.application.relocation,
    travel: a.application.travel,
    currentlyEmployed: a.application.currentlyEmployed,
    currentSalary: clean(a.application.currentSalary),
    expectedSalary: clean(a.application.expectedSalary),
  };
  return p;
}

const digits = (v: string) => v.replace(/\D/g, '');
const urlCore = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True only if the whole URL appears in the CV (not just its domain or a prefix of a longer URL). */
function urlInText(url: string, text: string): boolean {
  const core = urlCore(url);
  if (!core || !core.includes('.')) return false;
  const hay = text.toLowerCase().replace(/https?:\/\//g, '').replace(/www\./g, '');
  // Sentence punctuation right after a link ("… github.com/jane.") still ends the link.
  // Anything else that could continue a URL ("github.com/jane" inside "github.com/jane.doe") means it was cut short.
  return new RegExp(`(?:^|[^a-z0-9./-])${escapeRe(core)}/?(?=[.,;:!?)\\]]+(?:\\s|$)|\\s|$|[^a-z0-9_./-])`).test(hay);
}

const tokens = (v: string) => v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 || /\d/.test(t));

/** True when most words of `value` literally occur in the CV text. */
function hasEvidence(value: string, text: string): boolean {
  const toks = tokens(value);
  if (toks.length === 0) return false;
  const hay = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return toks.filter((t) => hay.includes(` ${t} `)).length / toks.length >= 0.6;
}

/**
 * Removes anything the model could have invented: values that cannot be found in the CV text
 * (PRD §7.4: missing information stays empty; the user fills it in).
 */
function evidenceCheck(p: ProfileData, text: string): string[] {
  const warnings: string[] = [];
  const drop = (label: string, value: unknown) => warnings.push(`${label} "${String(value)}" was not found in the CV and was removed.`);
  const lower = text.toLowerCase();
  const textDigits = digits(text);

  if (p.personal.email && !lower.includes(p.personal.email.toLowerCase())) {
    drop('Email', p.personal.email);
    p.personal.email = null;
  }
  if (p.personal.phone) {
    const d = digits(p.personal.phone);
    // Allow a country code the CV omitted or wrote differently: compare the last 9 digits.
    if (d.length < 7 || !textDigits.includes(d.slice(-9))) {
      drop('Phone', p.personal.phone);
      p.personal.phone = null;
    }
  }
  p.personal.links = p.personal.links.filter((l) => urlInText(l.url, text) || (drop('Link', l.url), false));
  for (const pr of p.projects) {
    if (pr.url && !urlInText(pr.url, text)) {
      drop('Project link', pr.url);
      pr.url = null;
    }
  }
  for (const key of ['country', 'timezone', 'location'] as const) {
    const v = p.personal[key];
    if (v && !hasEvidence(v, text)) {
      drop(key === 'timezone' ? 'Time zone' : key === 'country' ? 'Country' : 'Location', v);
      p.personal[key] = null;
    }
  }
  const app = p.application;
  for (const key of ['workAuthorization', 'visaStatus', 'noticePeriod', 'currentSalary', 'expectedSalary'] as const) {
    const v = app[key];
    if (v && !hasEvidence(v, text)) {
      drop(key.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase()), v);
      app[key] = null;
    }
  }
  if (app.relocation !== null && !/relocat/i.test(text)) app.relocation = null;
  if (app.travel !== null && !/\btravel/i.test(text)) app.travel = null;
  // "Currently employed" is only known when a role is marked as ongoing.
  app.currentlyEmployed = p.experience.some((e) => e.current) ? true : null;
  return warnings;
}

/** The AI was set up but couldn't read the CV: the user sees why and tries again (no fallback to fixed rules). */
export class CvReadError extends Error {
  override name = 'CvReadError';
}

/** `file`: the original document, for models that read files; the text always goes too (and is what facts are checked against). */
export async function extractProfile(text: string, ai: Ai | null, opts: { now?: Date; file?: { data: Uint8Array; mediaType: string } } = {}): Promise<ExtractionResult> {
  const now = opts.now ?? new Date();
  if (!ai || !ai.status().configured) {
    return { data: heuristicExtract(text, now), method: 'heuristic', warnings: ['Extracted offline without AI; please review every field.'] };
  }
  try {
    const out = await ai.generateObject({
      role: 'fast',
      task: 'cv-extract',
      pin: CV_EXTRACT_MODEL,
      schema: AiExtractionSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: `CV text:\n"""\n${text.slice(0, 30_000)}\n"""`,
      file: opts.file,
    });
    const data = fromAi(out);
    const warnings = evidenceCheck(data, text);
    data.previousTitles = data.previousTitles.length ? data.previousTitles : [...new Set(data.experience.map((e) => e.title).filter((t): t is string => !!t))];
    data.yearsExperience = computeYearsOfExperience(data, now) ?? data.yearsExperience;
    const valid = ProfileDataSchema.safeParse(assignIds(data));
    if (!valid.success) throw new Error(`AI output failed validation: ${valid.error.issues[0]?.message}`);
    return { data: valid.data, method: 'ai', warnings };
  } catch (err) {
    throw new CvReadError(`The AI couldn’t read your CV: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
}
