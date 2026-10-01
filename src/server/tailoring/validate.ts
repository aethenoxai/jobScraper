/**
 * Grounding validator for tailored CVs (N3). Deterministic: a tailored CV may reword and reorder the
 * master profile, but never add facts — numbers, quantities, skills, titles, employers, clients or experience it
 * doesn't contain — and never drop work history, degrees or whole sections.
 */
import { mentions } from '../matching/gates';
import { findSkills } from '../matching/vocabulary';
import type { ProfileData } from '../profile/model';
import { CV_SECTIONS, maxClaimableYears, type CvSection, type TailoredBullet, type TailoredCv } from './model';

export type ViolationKind = 'unknown-id' | 'duplicate' | 'missing-experience' | 'missing-education' | 'section' | 'no-source' | 'foreign-source' | 'number' | 'skill' | 'headline' | 'years' | 'employer';

export interface Violation {
  kind: ViolationKind;
  path: string;
  message: string;
}

/** Common alternative names for the same skill. */
const ALIASES: string[][] = [
  ['node.js', 'node', 'nodejs'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['postgresql', 'postgres', 'psql'],
  ['kubernetes', 'k8s'],
  ['go', 'golang'],
  ['react', 'react.js', 'reactjs'],
  ['next.js', 'nextjs'],
  ['vue', 'vue.js', 'vuejs'],
  ['amazon web services', 'aws'],
  ['google cloud', 'gcp', 'google cloud platform'],
  ['machine learning', 'ml'],
  ['c#', 'csharp'],
  ['ci/cd', 'cicd'],
];
const norm = (s: string) => s.trim().toLowerCase();
const aliasesOf = (s: string) => ALIASES.find((group) => group.includes(norm(s))) ?? [norm(s)];
const mentionsAny = (text: string, skill: string) => aliasesOf(skill).some((a) => mentions(text, a));
/** Whether two names are the same skill ("Postgres" and "PostgreSQL"). */
export const sameSkill = (a: string, b: string) => aliasesOf(a).includes(norm(b));

function skillSet(profile: ProfileData): Set<string> {
  const names = [...profile.skills.map((s) => s.name), ...profile.projects.flatMap((p) => p.technologies)];
  return new Set(names.flatMap(aliasesOf));
}

/**
 * Numbers as written ("35%", "35 percent", "1,200", "$2.1M", "2M", "forty percent") normalised for comparison. Digits
 * inside names (K8s, EC2, S3, p95) are not claims and are skipped; a unit letter counts only as a whole word.
 */
const UNITS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, ...UNITS };
const NUMBER_WORD = new RegExp(`\\b(?:(${Object.keys(TENS).join('|')})(?:[\\s-](${Object.keys(ONES).join('|')}))?|(${Object.keys(UNITS).join('|')})|(a dozen|dozen))\\b`, 'gi');

/** "five" → "5", "twenty-five" → "25", "a dozen" → "12" ("one" stays a word: it's rarely a claim). */
function wordsToDigits(text: string): string {
  return text.replace(NUMBER_WORD, (_m, tens?: string, ones?: string, unit?: string, dozen?: string) =>
    String(dozen ? 12 : tens ? TENS[tens.toLowerCase()] + (ones ? ONES[ones.toLowerCase()] : 0) : UNITS[unit!.toLowerCase()]),
  );
}

export function numbersIn(input: string): string[] {
  const text = wordsToDigits(input);
  return [...text.matchAll(/(?<![\p{L}\d.,])(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?%|\s?(?:percent|per cent)\b|\s?(?:k|m|bn|b|x)\b)?(?![\p{L}\d])/giu)].map((m) =>
    m[0].toLowerCase().replace(/\s?(?:percent|per cent)$/, '%').replace(/[,\s]/g, ''),
  );
}

/** Numbers of `claim` that `source` doesn't contain. A number without a currency matches one with it, not the reverse. */
function inventedNumbers(claim: string, source: string): string[] {
  const known = new Set(numbersIn(source).flatMap((n) => [n, n.replace(/^[$€£₹]/, '')]));
  return [...new Set(numbersIn(claim).filter((n) => !known.has(n)))];
}

/** Words that state a quantity ("tripled", "halved", "millions"): they need the same backing as digits. */
const QUANTITY_WORDS = /\b(doubl\w*|tripl\w*|quadrupl\w*|halv\w*|half|twice|thrice|tenfold|dozens?|hundreds|thousands|millions|billions)\b/gi;
const stem = (w: string) => w.toLowerCase().replace(/(ed|ing|es|s)$/, '').slice(0, 5);
export function inventedQuantities(claim: string, source: string): string[] {
  const src = source.toLowerCase();
  return [...new Set([...claim.matchAll(QUANTITY_WORDS)].map((m) => m[0]).filter((w) => !src.includes(stem(w))))];
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30 };
/** Years of experience claimed in a text: "5 years", "5+ yrs", "a 15-year career", "fifteen years", "a decade". */
export function yearsClaimed(text: string): number[] {
  const out = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\+?\s*-?\s*(?:years?|yrs?)\b/gi)].map((m) => Number(m[1]));
  for (const m of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)[\s-]+(?:\+\s*)?years?\b/gi)) out.push(NUMBER_WORDS[m[1].toLowerCase()]);
  for (const m of text.matchAll(/\b(a|one|two|three|several|multiple)?\s*decades?\b/gi)) out.push(m[1] && !/^(a|one)$/i.test(m[1]) ? 20 : 10);
  return out;
}

/** Names a text credits work to: "for Google", "at Acme", "Ex-Netflix" (not "Fortune 500", which a number follows). */
export function namedOrganisations(text: string): string[] {
  // The name must end at a word boundary before the "no number follows" check, or backtracking would cut "Fortune" short.
  // A name is capitalised words on one line; a full stop only inside a word ("Node.js"), never ending one.
  const word = "[A-Z](?:[\\w&'’-]|\\.(?=\\w))*";
  const re = new RegExp(`\\b(?:[Aa]t|[Ff]or|[Ff]rom|[Bb]y|[Ww]ith)[ \\t]+(${word}(?:[ \\t]+${word})*)(?![\\w&'’-]|\\.\\w)(?![ \\t]*\\d)`, 'g');
  const names = [...text.matchAll(re)].map((m) => m[1]);
  for (const m of text.matchAll(/\b[Ee]x-([A-Z][\w&.'-]*)/g)) names.push(m[1]);
  // Sentence punctuation is not part of a name ("…with Triage." → "Triage"; "Node.js" keeps its dot).
  return names.map((n) => n.replace(/[.'’-]+$/, '')).filter(Boolean);
}

function sourceIndex(profile: ProfileData) {
  const owner = new Map<string, string>(); // bullet id → experience/project id
  const text = new Map<string, string>();
  const add = (id: string, ownerId: string, t: string) => {
    owner.set(id, ownerId);
    text.set(id, t);
  };
  for (const e of profile.experience) for (const b of e.bullets) add(b.id, e.id, b.text);
  for (const p of profile.projects) for (const b of p.bullets) add(b.id, p.id, b.text);
  // Project/experience descriptions can also ground a bullet (cited by the item's own id).
  for (const e of profile.experience) add(e.id, e.id, [e.title, e.summary].filter(Boolean).join(' '));
  for (const p of profile.projects) add(p.id, p.id, [p.name, p.description, ...p.technologies].filter(Boolean).join(' '));
  // Everything a role says about itself: skills it used may be named in any of its bullets.
  const roleText = new Map<string, string>();
  for (const e of profile.experience) roleText.set(e.id, [e.title, e.summary, ...e.bullets.map((b) => b.text)].filter(Boolean).join('\n'));
  for (const p of profile.projects) roleText.set(p.id, [p.name, p.description, ...p.technologies, ...p.bullets.map((b) => b.text)].filter(Boolean).join('\n'));
  const hasOwnText = new Set([...profile.experience.filter((e) => e.summary).map((e) => e.id), ...profile.projects.filter((p) => p.description).map((p) => p.id)]);
  return { owner, text, roleText, hasOwnText };
}

/** All profile text, for checking the summary and headline. */
function profileText(p: ProfileData): string {
  return [
    p.headline,
    p.summary,
    ...p.experience.flatMap((e) => [e.title, e.company, e.summary, ...e.bullets.map((b) => b.text)]),
    ...p.projects.flatMap((x) => [x.name, x.description, ...x.technologies, ...x.bullets.map((b) => b.text)]),
    ...p.education.flatMap((e) => [e.degree, e.field, e.institution, e.grade]),
    ...p.certifications.flatMap((c) => [c.name, c.issuer]),
    ...p.skills.map((s) => s.name),
  ]
    .filter(Boolean)
    .join('\n');
}

function bulletViolations(itemId: string, bullet: TailoredBullet, path: string, profile: ProfileData, idx: ReturnType<typeof sourceIndex>): Violation[] {
  const out: Violation[] = [];
  const known = bullet.sources.filter((s) => idx.owner.has(s));
  // Citing only the job itself (its title) is not a source unless the role has its own description.
  const lineLevel = known.some((s) => s !== itemId) || (known.includes(itemId) && idx.hasOwnText.has(itemId));
  if (!known.length || !lineLevel) return [{ kind: 'no-source', path, message: 'The bullet does not cite any line of your CV' }];
  if (known.some((s) => idx.owner.get(s) !== itemId)) out.push({ kind: 'foreign-source', path, message: 'The bullet uses an achievement from a different role' });
  const cited = known.map((s) => idx.text.get(s) ?? '').join('\n');
  const invented = inventedNumbers(bullet.text, cited);
  const quantities = inventedQuantities(bullet.text, cited);
  if (invented.length || quantities.length) out.push({ kind: 'number', path, message: `Numbers or amounts not in your CV: ${[...invented, ...quantities].join(', ')}` });
  const role = idx.roleText.get(itemId) ?? '';
  const newSkills = findSkills(bullet.text).filter((s) => !mentionsAny(cited, s) && !mentionsAny(role, s));
  if (newSkills.length) out.push({ kind: 'skill', path, message: `Skills this role doesn't show in your CV: ${newSkills.join(', ')}` });
  const companies = profile.experience.map((e) => e.company).filter((c): c is string => !!c);
  const skills = skillSet(profile);
  const names = namedOrganisations(bullet.text).filter((n) => !mentions(cited, n) && !mentions(role, n) && !companies.some((c) => mentions(c, n) || mentions(n, c)) && !aliasesOf(n).some((a) => skills.has(a)));
  if (names.length) out.push({ kind: 'employer', path, message: `Names not in this part of your CV: ${names.join(', ')}` });
  return out;
}

/** Sections that have content and so must appear in the CV, once each. */
function sectionsWithContent(cv: TailoredCv, profile: ProfileData): CvSection[] {
  const has: Record<CvSection, boolean> = {
    summary: !!cv.summary,
    skills: cv.skills.length > 0,
    experience: profile.experience.length > 0,
    projects: cv.projects.length > 0,
    education: profile.education.length > 0,
    certifications: cv.certifications.length > 0,
    languages: cv.languages.length > 0,
  };
  return CV_SECTIONS.filter((s) => has[s]);
}

/** Titles the user has actually held (a wished-for target title is not one). */
export function allowedHeadlines(profile: ProfileData): string[] {
  return [...new Set([profile.headline, ...profile.previousTitles, ...profile.experience.map((e) => e.title)].filter((x): x is string => !!x))];
}

export function validateTailoredCv(cv: TailoredCv, profile: ProfileData): Violation[] {
  const v: Violation[] = [];
  const idx = sourceIndex(profile);
  const skills = skillSet(profile);
  const ids = (list: Array<{ id: string }>) => new Set(list.map((x) => x.id));

  const expIds = ids(profile.experience);
  const projIds = ids(profile.projects);
  for (const [field, known] of [
    ['education', ids(profile.education)],
    ['certifications', ids(profile.certifications)],
    ['languages', ids(profile.languages)],
  ] as const) {
    cv[field].forEach((id, i) => {
      if (!known.has(id)) v.push({ kind: 'unknown-id', path: `${field}.${id}`, message: `Unknown ${field} entry` });
      else if (cv[field].indexOf(id) !== i) v.push({ kind: 'duplicate', path: `${field}.${id}`, message: `The same ${field} entry is listed twice` });
    });
  }
  // A role or project listed twice would print twice on the CV.
  const repeated = (list: Array<{ id: string }>, i: number) => list.findIndex((x) => x.id === list[i].id) !== i;
  cv.experience.forEach((e, i) => {
    if (!expIds.has(e.id)) return void v.push({ kind: 'unknown-id', path: `experience.${i}`, message: 'Unknown job' });
    if (repeated(cv.experience, i)) return void v.push({ kind: 'duplicate', path: `experience.${i}`, message: 'The same job is listed twice' });
    e.bullets.forEach((b, j) => v.push(...bulletViolations(e.id, b, `experience.${i}.bullets.${j}`, profile, idx)));
  });
  cv.projects.forEach((p, i) => {
    if (!projIds.has(p.id)) return void v.push({ kind: 'unknown-id', path: `projects.${i}`, message: 'Unknown project' });
    if (repeated(cv.projects, i)) return void v.push({ kind: 'duplicate', path: `projects.${i}`, message: 'The same project is listed twice' });
    p.bullets.forEach((b, j) => v.push(...bulletViolations(p.id, b, `projects.${i}.bullets.${j}`, profile, idx)));
  });
  for (const e of profile.experience) {
    // Leaving a job out would misrepresent the career history (dates are shown from the master profile).
    if (!cv.experience.some((x) => x.id === e.id)) v.push({ kind: 'missing-experience', path: `experience.${e.id}`, message: `${e.title ?? 'A job'} at ${e.company ?? 'a company'} is missing` });
  }
  for (const e of profile.education) {
    if (!cv.education.includes(e.id)) v.push({ kind: 'missing-education', path: `education.${e.id}`, message: `${e.degree ?? 'A degree'}${e.institution ? ` (${e.institution})` : ''} is missing` });
  }
  const needed = sectionsWithContent(cv, profile);
  const missing = needed.filter((s) => !cv.sectionOrder.includes(s));
  const duplicated = cv.sectionOrder.filter((s, i) => cv.sectionOrder.indexOf(s) !== i);
  if (missing.length || duplicated.length) {
    v.push({ kind: 'section', path: 'sectionOrder', message: [missing.length ? `Sections left out: ${missing.join(', ')}` : '', duplicated.length ? `Sections repeated: ${[...new Set(duplicated)].join(', ')}` : ''].filter(Boolean).join('; ') });
  }
  cv.skills.forEach((s, i) => {
    if (!aliasesOf(s).some((a) => skills.has(a))) v.push({ kind: 'skill', path: `skills.${i}`, message: `"${s}" is not in your profile` });
  });

  const titles = allowedHeadlines(profile).map(norm);
  if (cv.headline && !titles.includes(norm(cv.headline))) v.push({ kind: 'headline', path: 'headline', message: `"${cv.headline}" is not a title you have held` });

  // The profile's own summary, as written, is the user's statement; anything else must be backed by the profile.
  if (cv.summary && norm(cv.summary) !== norm(profile.summary ?? '')) {
    const facts = profileText(profile);
    // Years of experience are checked on their own below.
    const withoutYears = cv.summary.replace(/(\d+(?:\.\d+)?)\s*\+?\s*-?\s*(?:years?|yrs?)\b/gi, '');
    const invented = [...inventedNumbers(withoutYears, `${facts}\n${profile.yearsExperience ?? ''}`), ...inventedQuantities(withoutYears, facts)];
    if (invented.length) v.push({ kind: 'number', path: 'summary', message: `Numbers or amounts not in your CV: ${invented.join(', ')}` });
    const max = maxClaimableYears(profile.yearsExperience);
    if (yearsClaimed(cv.summary).some((y) => y > max)) v.push({ kind: 'years', path: 'summary', message: `Claims more than your ${max} years of experience` });
    const companies = profile.experience.map((e) => e.company).filter((c): c is string => !!c);
    for (const name of namedOrganisations(cv.summary)) {
      if (!companies.some((c) => mentions(c, name) || mentions(name, c)) && !aliasesOf(name).some((a) => skills.has(a)) && !mentions(facts, name)) {
        v.push({ kind: 'employer', path: 'summary', message: `"${name}" is not an employer in your profile` });
      }
    }
    // A skill the profile states anywhere (its own summary, a bullet, a project) is the user's fact too.
    const summarySkills = findSkills(cv.summary).filter((s) => !aliasesOf(s).some((a) => skills.has(a)) && !mentionsAny(facts, s));
    if (summarySkills.length) v.push({ kind: 'skill', path: 'summary', message: `Skills not in your profile: ${summarySkills.join(', ')}` });
  }
  return v;
}

/** Fixes every violation by falling back to master data, so the result always validates. */
export function repairTailoredCv(cv: TailoredCv, profile: ProfileData, fallbackSummary: string | null): TailoredCv {
  const idx = sourceIndex(profile);
  const skills = skillSet(profile);
  const known = { education: new Set(profile.education.map((x) => x.id)), certifications: new Set(profile.certifications.map((x) => x.id)), languages: new Set(profile.languages.map((x) => x.id)) };

  const fixBullets = (itemId: string, bullets: TailoredBullet[]): TailoredBullet[] => {
    const used = new Set<string>();
    const out: TailoredBullet[] = [];
    for (const b of bullets) {
      if (!bulletViolations(itemId, b, '', profile, idx).length) {
        out.push(b);
        b.sources.forEach((s) => used.add(s));
        continue;
      }
      // Fall back to the master wording of the first valid source of this role.
      const source = b.sources.find((s) => idx.owner.get(s) === itemId && s !== itemId && !used.has(s));
      if (source) {
        used.add(source);
        out.push({ text: idx.text.get(source)!, sources: [source] });
      }
    }
    return out;
  };

  const firstOf = <T,>(list: T[], key: (x: T) => string) => list.filter((x, i) => list.findIndex((y) => key(y) === key(x)) === i);
  const experience = firstOf(cv.experience, (e) => e.id).filter((e) => profile.experience.some((x) => x.id === e.id)).map((e) => ({ id: e.id, bullets: fixBullets(e.id, e.bullets) }));
  for (const e of profile.experience) {
    if (!experience.some((x) => x.id === e.id)) experience.push({ id: e.id, bullets: e.bullets.map((b) => ({ text: b.text, sources: [b.id] })) });
  }
  // Keep the master chronological order of jobs.
  experience.sort((a, b) => profile.experience.findIndex((x) => x.id === a.id) - profile.experience.findIndex((x) => x.id === b.id));

  const education = [...new Set(cv.education)].filter((id) => known.education.has(id));
  for (const e of profile.education) if (!education.includes(e.id)) education.push(e.id);

  const repaired: TailoredCv = {
    ...cv,
    experience,
    projects: firstOf(cv.projects, (p) => p.id).filter((p) => profile.projects.some((x) => x.id === p.id)).map((p) => ({ id: p.id, bullets: fixBullets(p.id, p.bullets) })),
    skills: cv.skills.filter((s) => aliasesOf(s).some((a) => skills.has(a))),
    education,
    certifications: [...new Set(cv.certifications)].filter((id) => known.certifications.has(id)),
    languages: [...new Set(cv.languages)].filter((id) => known.languages.has(id)),
    sectionOrder: [...new Set(cv.sectionOrder)],
  };
  const remaining = validateTailoredCv(repaired, profile);
  if (remaining.some((x) => x.kind === 'headline')) repaired.headline = profile.headline;
  if (remaining.some((x) => x.path === 'summary')) {
    repaired.summary = fallbackSummary;
    // The offline summary is built from facts; if even that can't be verified, use the profile's own words.
    if (validateTailoredCv(repaired, profile).some((x) => x.path === 'summary')) repaired.summary = profile.summary;
  }
  for (const s of sectionsWithContent(repaired, profile)) if (!repaired.sectionOrder.includes(s)) repaired.sectionOrder.push(s);
  return repaired;
}
