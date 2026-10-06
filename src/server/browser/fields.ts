/**
 * Answers application-form fields truthfully (PLAN §2.11): first by rules from profile data, then by a grounded AI
 * mapper that must cite the profile and pick only offered options. A required field without a truthful answer is
 * reported as unanswerable, and the application is skipped rather than guessed.
 */
import { z } from 'zod';
import type { Ai } from '../ai';
import { resolvePlaces } from '../matching/geo';
import type { ProfileData } from '../profile/model';
import { validateClaims } from '../tailoring/cover-letter';
import { mentions } from '../matching/gates';
import { findSkills } from '../matching/vocabulary';
import { numbersIn, sameSkill } from '../tailoring/validate';

export type FieldKind = 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file';

export interface FormField {
  /** Identifies the element on the page (set by the extractor). */
  key: string;
  kind: FieldKind;
  label: string;
  name: string;
  required: boolean;
  /** Visible option labels (select, radio). */
  options: string[];
  /** A custom dropdown (role=combobox) rather than a native <select>: its options appear when it is opened. */
  combobox?: boolean;
}

export interface FieldAnswer {
  key: string;
  value: string | { file: string };
  /** Where the answer comes from: a profile path, "cv" or "cover letter". */
  source: string;
  method: 'rule' | 'ai';
}

export interface MapContext {
  cvFile: string;
  coverLetterFile?: string | null;
  /** ISO country of the job, used when a work-authorization question doesn't name one. */
  jobCountry: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[*✱:]/g, ' ').replace(/\s+/g, ' ').trim();

/** The offered option that means `wanted` ("Yes" matches "Yes, I am"), or null. */
export function pickOption(options: string[], wanted: string): string | null {
  const w = norm(wanted);
  return options.find((o) => norm(o) === w) ?? options.find((o) => norm(o).startsWith(`${w} `) || norm(o).startsWith(`${w},`)) ?? null;
}

const DECLINE = /decline|prefer not|do not wish|don.?t wish|not to (?:say|disclose|answer)|rather not|do not want to answer|don.?t want to answer/i;
const EEO = /\b(gender|sex|race|ethnic|hispanic|latin[oax]|veteran|disabilit|pronoun|sexual orientation|transgender|demographic|self-identif)/;
/** Option sets that give a demographic question away even when its label doesn't (e.g. a radio named "q7"). */
const DEMOGRAPHIC_OPTIONS = /^(?:male|female|non-?binary|man|woman|asian|white|black|african american|hispanic|latino|latina|native american|pacific islander|two or more races|protected veteran)\b/i;
export const isDemographic = (f: FormField) => EEO.test(norm(`${f.label} ${f.name}`)) || f.options.filter((o) => DEMOGRAPHIC_OPTIONS.test(o.trim())).length >= 2;

/** Questions whose answer is a legal or personal statement: answered only by explicit rules, never guessed. */
const SENSITIVE = /\b(authori[sz]|sponsor|visa|work permit|right to work|relocat|travel|salary|compensation|ctc|clearance|criminal|convict|felony|background check|drug test|18 years|over 18|age\b|religio|marital)/;

const NEGATION = /\b(?:not|no|never|without|cannot|unable|require[sd]?|requiring|need(?:s|ed)?|pending|seeking|apply(?:ing)? for|in process)\b|n['’]t\b/i;
const AUTHORIZED = /\b(citizen|national|permanent resident|green card|authori[sz]ed|work permit|right to work|indefinite leave|settled status|eligible to work)\b/i;
const NO_SPONSORSHIP_STATUS = /\b(citizen|national|permanent resident|green card|indefinite leave|ILR|settled status)\b/i;

/**
 * What the profile says about working in `country` (ISO code), clause by clause ("Citizen of India; I need
 * sponsorship for the UK"). A clause naming no country speaks for the profile's own country. Any negation or
 * "need" in a relevant clause makes the answer unknown: Job Scraper never states a legal fact it can't support.
 */
function workStatus(p: ProfileData, country: string | null): { authorized: boolean; noSponsorship: boolean } | null {
  const text = [p.application.workAuthorization, p.application.visaStatus].filter(Boolean).join('; ');
  if (!country || !text) return null;
  const own = resolvePlaces(p.personal.country ?? p.personal.location ?? '').countries;
  const clauses = text.split(/[;.]|\bbut\b|\band\b/i).map((c) => c.trim()).filter(Boolean);
  const relevant = clauses.filter((c) => {
    const named = resolvePlaces(c).countries;
    return named.size ? named.has(country) : own.has(country);
  });
  if (!relevant.length || relevant.some((c) => NEGATION.test(c))) return null;
  const authorized = relevant.some((c) => AUTHORIZED.test(c));
  if (!authorized) return null;
  return { authorized, noSponsorship: relevant.some((c) => NO_SPONSORSHIP_STATUS.test(c)) };
}

const link = (p: ProfileData, re: RegExp) => p.personal.links.find((l) => re.test(`${l.label ?? ''} ${l.url ?? ''}`))?.url ?? null;
const current = (p: ProfileData) => p.experience.find((e) => e.current) ?? p.experience[0];

/** Rules: label pattern → answer from the profile (or null when the profile has nothing to say). */
function ruleAnswer(f: FormField, p: ProfileData, ctx: MapContext): { value: string | { file: string }; source: string } | null {
  const l = norm(`${f.label} ${f.name}`);
  const parts = (p.personal.fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const yesNo = (b: boolean | null | undefined, source: string) => {
    if (b === null || b === undefined) return null;
    const option = f.options.length ? pickOption(f.options, b ? 'Yes' : 'No') : b ? 'Yes' : 'No';
    return option ? { value: option, source } : null;
  };

  if (f.kind === 'file') {
    if (/cover/.test(l)) return ctx.coverLetterFile ? { value: { file: ctx.coverLetterFile }, source: 'cover letter' } : null;
    // Only CV/resume uploads get the CV; a transcript or portfolio upload stays unanswered.
    if (/resume|\bcv\b|curriculum vitae/.test(l)) return { value: { file: ctx.cvFile }, source: 'cv' };
    return null;
  }
  if (isDemographic(f)) {
    const decline = f.options.find((o) => DECLINE.test(o));
    return decline ? { value: decline, source: 'preference: decline to self-identify' } : null;
  }
  const place = resolvePlaces(f.label).countries;
  const askedCountry = place.size === 1 ? [...place][0] : ctx.jobCountry;
  if (/sponsor/.test(l)) {
    // "No sponsorship needed" only for citizens and permanent residents: other permits may need it later.
    return workStatus(p, askedCountry)?.noSponsorship ? yesNo(false, 'application.workAuthorization') : null;
  }
  if (/authori[sz]ed to work|work authori[sz]ation|right to work|legally (?:able|authori[sz]ed|eligible)|eligible to work/.test(l)) {
    return workStatus(p, askedCountry)?.authorized ? yesNo(true, 'application.workAuthorization') : null;
  }
  if (/relocat/.test(l)) return yesNo(p.application.relocation, 'application.relocation');
  if (/travel/.test(l) && f.options.length) return yesNo(p.application.travel, 'application.travel');

  if (/first[ _-]?name|given name|forename/.test(l)) return parts[0] ? { value: parts[0], source: 'personal.fullName' } : null;
  if (/last[ _-]?name|surname|family name/.test(l)) return parts.length > 1 ? { value: parts.slice(1).join(' '), source: 'personal.fullName' } : null;
  if (f.kind === 'email' || /e-?mail/.test(l)) return p.personal.email ? { value: p.personal.email, source: 'personal.email' } : null;
  if (f.kind === 'tel' || /phone|mobile|cell/.test(l)) return p.personal.phone ? { value: p.personal.phone, source: 'personal.phone' } : null;
  if (/linkedin/.test(l)) return link(p, /linkedin/i) ? { value: link(p, /linkedin/i)!, source: 'personal.links' } : null;
  if (/github/.test(l)) return link(p, /github/i) ? { value: link(p, /github/i)!, source: 'personal.links' } : null;
  if (/portfolio|website|personal site|blog/.test(l)) {
    const site = p.personal.links.find((x) => !/linkedin|github/i.test(`${x.label} ${x.url}`))?.url;
    return site ? { value: site, source: 'personal.links' } : null;
  }
  if (/(?:full|your|candidate|legal) name|^name\b/.test(l) && !/company|employer|school|reference/.test(l)) return p.personal.fullName ? { value: p.personal.fullName, source: 'personal.fullName' } : null;
  if (/current (?:company|employer)|^org\b|organi[sz]ation|employer/.test(l)) return current(p)?.company ? { value: current(p)!.company!, source: 'experience.company' } : null;
  if (/current (?:job )?title|current (?:position|role)|^title\b|job title/.test(l)) return current(p)?.title ? { value: current(p)!.title!, source: 'experience.title' } : null;
  if (/notice period|when can you start|earliest start|availability to start/.test(l)) return p.application.noticePeriod ? { value: p.application.noticePeriod, source: 'application.noticePeriod' } : null;
  if (/expected (?:salary|compensation|ctc)|salary expectation|desired (?:salary|compensation|pay)/.test(l)) return p.application.expectedSalary ? { value: p.application.expectedSalary, source: 'application.expectedSalary' } : null;
  if (/current (?:salary|ctc|compensation)/.test(l)) return p.application.currentSalary ? { value: p.application.currentSalary, source: 'application.currentSalary' } : null;
  if (/years of (?:relevant |professional |work )?experience|how many years/.test(l) && !/\b(with|in|of) [a-z]/.test(l.replace(/years of (?:relevant |professional |work )?experience/, ''))) {
    return p.yearsExperience !== null ? { value: String(p.yearsExperience), source: 'yearsExperience' } : null;
  }
  if (/\bcountry\b/.test(l)) {
    const c = p.personal.country;
    if (!c) return null;
    const option = f.options.length ? pickOption(f.options, c) : c;
    return option ? { value: option, source: 'personal.country' } : null;
  }
  if (/\b(location|city|where are you (?:based|located)|current address)\b/.test(l)) return p.personal.location ? { value: p.personal.location, source: 'personal.location' } : null;
  if (/how did you (?:hear|find|learn)/.test(l)) {
    const option = f.options.length ? (f.options.find((o) => /job board|online|website|internet|job search/i.test(o)) ?? f.options.find((o) => /^other\b/i.test(o)) ?? null) : 'Online job search';
    return option ? { value: option, source: 'how the job was found' } : null;
  }
  return null;
}

export function mapFields(fields: FormField[], profile: ProfileData, ctx: MapContext): { answers: FieldAnswer[]; unanswerable: FormField[]; rest: FormField[] } {
  const answers: FieldAnswer[] = [];
  const rest: FormField[] = [];
  for (const f of fields) {
    let a = ruleAnswer(f, profile, ctx);
    // An answer to a choice must be one of the choices ("5" years doesn't fit "3-5" by itself).
    if (a && typeof a.value === 'string' && (f.kind === 'select' || f.kind === 'radio')) {
      const option = pickOption(f.options, a.value);
      a = option ? { ...a, value: option } : null;
    }
    if (a) answers.push({ key: f.key, value: a.value, source: a.source, method: 'rule' });
    else rest.push(f);
  }
  // Optional diversity questions without a "decline" option are left empty, never guessed (and never block).
  const unanswerable = rest.filter((f) => f.required);
  return { answers, unanswerable, rest };
}

/** Fields the AI may try: not files, not demographics, not legal/personal statements. */
export const aiMayAnswer = (f: FormField) => f.kind !== 'file' && f.kind !== 'checkbox' && !isDemographic(f) && !SENSITIVE.test(norm(`${f.label} ${f.name}`));

const AiAnswersSchema = z.object({ answers: z.array(z.object({ key: z.string(), answer: z.string().nullable(), source: z.string(), evidence: z.string() })) });

const SYSTEM = `You fill in a job application form for the candidate, truthfully.
For each field, answer ONLY if the candidate's profile states the fact; otherwise return answer null.
- Never invent experience, numbers, skills, employers, clearances, licences or preferences.
- For fields with options, the answer must be exactly one of the options.
- "source" is the profile field your answer comes from (e.g. "yearsExperience", "experience", "skills").
- "evidence" is the exact words from the profile that support the answer (copied, not paraphrased).
- Free-text answers: at most 3 sentences, first person, only profile facts.`;

const PROFILE_KEYS = new Set(['personal', 'headline', 'summary', 'yearsExperience', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages', 'application', 'targetTitles', 'previousTitles', 'preferences']);

/** Asks the AI for the fields the rules couldn't answer, keeping only grounded answers. */
/** The profile's statements, item by item (what an AI answer may quote as its evidence). */
function profileStatements(p: ProfileData): string[] {
  return [
    p.headline,
    p.summary,
    ...p.skills.map((x) => x.name),
    ...p.experience.flatMap((e) => [e.title, e.company, e.summary, ...e.bullets.map((b) => b.text)]),
    ...p.projects.flatMap((x) => [x.name, x.description, ...x.technologies, ...x.bullets.map((b) => b.text)]),
    ...p.education.flatMap((e) => [e.degree, e.field, e.institution]),
    ...p.certifications.map((c) => c.name),
    ...p.languages.map((l) => l.name),
  ].filter((x): x is string => !!x?.trim());
}

/** Whether the profile shows this skill anywhere (skills, project technologies, or its own words). */
function profileHasSkill(p: ProfileData, skill: string): boolean {
  if ([...p.skills.map((x) => x.name), ...p.projects.flatMap((x) => x.technologies)].some((n) => sameSkill(n, skill))) return true;
  return mentions(profileStatements(p).join('\n'), skill);
}

const QUESTION_STOP = new Set(['you', 'your', 'have', 'with', 'are', 'the', 'and', 'for', 'any', 'how', 'many', 'much', 'what', 'which', 'did', 'does', 'experience', 'years', 'year', 'working', 'work', 'able', 'comfortable', 'ever', 'been', 'this', 'that', 'our', 'role', 'job', 'please', 'describe']);
const contentWords = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []).filter((w) => !QUESTION_STOP.has(w)));
const NEGATIVE = /^(?:no|none|never|0|not at all)\b/i;

export async function mapWithAi(fields: FormField[], profile: ProfileData, ai: Ai | null, job: { company: string; title: string; description?: string }, signal?: AbortSignal): Promise<FieldAnswer[]> {
  fields = fields.filter(aiMayAnswer);
  if (!fields.length || !ai?.taskStatus('form-answers').configured) return [];
  const prompt = [
    `Job: ${job.title} at ${job.company}`,
    'Form fields:',
    ...fields.map((f) => `- key=${f.key} · ${f.kind}${f.required ? ' · required' : ''} · "${f.label}"${f.options.length ? ` · options: ${f.options.map((o) => `"${o}"`).join(', ')}` : ''}`),
    '',
    // Only what form answers can need: no contact details, salaries or visa data (those are answered by rules or not at all).
    `Candidate profile (JSON): ${JSON.stringify({ headline: profile.headline, summary: profile.summary, yearsExperience: profile.yearsExperience, location: profile.personal.location, skills: profile.skills.map((x) => x.name), experience: profile.experience, projects: profile.projects, education: profile.education, certifications: profile.certifications, languages: profile.languages })}`,
  ].join('\n');
  let out: z.infer<typeof AiAnswersSchema>;
  try {
    out = await ai.generateObject({ task: 'form-answers', schema: AiAnswersSchema, system: SYSTEM, prompt, timeoutMs: 60_000, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
  const facts = JSON.stringify(profile);
  const known = new Set(numbersIn(facts));
  const answers: FieldAnswer[] = [];
  const statements = profileStatements(profile).map((x) => x.toLowerCase());
  for (const a of out.answers) {
    const f = fields.find((x) => x.key === a.key);
    if (!f || !a.answer?.trim() || !PROFILE_KEYS.has(a.source.split('.')[0])) continue;
    const choice = f.kind === 'select' || f.kind === 'radio';
    const option = choice ? pickOption(f.options, a.answer) : null;
    if (choice && !option) continue;
    // A question about a skill the profile doesn't show: only an honest "no" may be given.
    if (findSkills(f.label).some((skill) => !profileHasSkill(profile, skill))) {
      if (option && NEGATIVE.test(option)) answers.push({ key: f.key, value: option, source: a.source, method: 'ai' });
      continue;
    }
    const numeric = /^\d+(?:\.\d+)?$/.test(a.answer.trim());
    // Years can't exceed the profile's total experience (another number in the profile isn't a duration).
    if (numeric && /\byears?\b/i.test(f.label)) {
      const years = profile.yearsExperience;
      if (years === null || Number(a.answer) > Math.max(years, Math.round(years))) continue;
    }
    // Anything but a plain number must quote a profile statement, and the quote must be about the question.
    const evidence = (a.evidence ?? '').trim().toLowerCase();
    if (!numeric) {
      const quoted = statements.some((x) => x === evidence || (evidence.length >= 15 && x.includes(evidence)));
      const labelWords = contentWords(f.label);
      const topical = (option ? mentions((a.evidence ?? '').trim(), option) : false) || [...contentWords(evidence)].some((w) => labelWords.has(w));
      if (!quoted || !topical) continue;
    }
    if (option) {
      if (numbersIn(option).every((n) => known.has(n))) answers.push({ key: f.key, value: option, source: a.source, method: 'ai' });
      continue;
    }
    if (numbersIn(a.answer).some((n) => !known.has(n))) continue;
    if (validateClaims(a.answer, profile, { title: job.title, company: job.company, description: job.description }).length) continue;
    answers.push({ key: f.key, value: a.answer.trim(), source: a.source, method: 'ai' });
  }
  return answers;
}
