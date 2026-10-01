/**
 * Offline CV extractor: rule-based, no AI. Used when no AI provider is configured and as
 * the fallback when an AI call fails. It only fills fields it can read directly from the
 * text; everything else stays empty (PRD §7.4).
 */
import { assignIds, computeYearsOfExperience, emptyProfile, ProfileDataSchema, sanitizeProfile, type ProfileData } from './model';

type Section = 'header' | 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'certifications' | 'languages' | 'other';

const HEADINGS: Array<[Section, RegExp]> = [
  ['summary', /^(professional\s+)?(summary|profile|about( me)?|objective|career objective|overview)$/i],
  ['experience', /^(work\s+|professional\s+|employment\s+)?(experience|history|employment)( history)?$|^internships?$|^career history$/i],
  ['education', /^(education|academic background|qualifications|education & training)$/i],
  ['skills', /^((technical|key|core|professional)\s+)?(skills|competencies|expertise)( & tools)?$/i],
  ['projects', /^(key\s+|personal\s+|selected\s+)?projects$/i],
  ['certifications', /^(certifications?|certificates|licen[cs]es( & certifications)?)$/i],
  ['languages', /^languages?$/i],
  ['other', /^(interests|hobbies|references|awards|achievements|publications|volunteering)$/i],
];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
const DATE = `(?:${MONTH_WORD}\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const END = `(?:${DATE}|present|current|now|today|ongoing)`;
const RANGE_RE = new RegExp(`\\(?\\s*(${DATE})\\s*(?:–|—|-|to|until)\\s*(${END})\\s*\\)?`, 'i');
const BULLET_RE = /^[•\-*·▪►◦‣]\s*/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\(?\d[\d\s().-]{6,}\d)/;
const URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s|·,]*)?/gi;
const SEPARATORS = /\s+[|·•]\s+|\s+—\s+|\s+–\s+/;

export interface DateRange {
  start: string | null;
  end: string | null;
  current: boolean;
}

export function toPartialDate(token: string): string | null {
  const t = token.trim().toLowerCase();
  const slash = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[2]}-${slash[1].padStart(2, '0')}`;
  const monthYear = t.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (monthYear) {
    const m = MONTHS[monthYear[1].slice(0, 4)] ?? MONTHS[monthYear[1].slice(0, 3)];
    return m ? `${monthYear[2]}-${String(m).padStart(2, '0')}` : monthYear[2];
  }
  const year = t.match(/^(\d{4})$/);
  return year ? year[1] : null;
}

/** Finds a date range such as "Jan 2023 – Present" or "(2017–2021)" in a line. */
export function parseDateRange(line: string): { range: DateRange; rest: string } | null {
  const m = line.match(RANGE_RE);
  if (!m) return null;
  const current = /present|current|now|today|ongoing/i.test(m[2]);
  const range = { start: toPartialDate(m[1]), end: current ? null : toPartialDate(m[2]), current };
  const rest = line.replace(m[0], ' ').replace(/\(\s*\)/g, ' ').replace(/[\s,|·–—-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  return { range, rest };
}

function headingOf(line: string): Section | null {
  const clean = line.replace(/[:：]$/, '').trim();
  if (clean.length > 40) return null;
  for (const [section, re] of HEADINGS) if (re.test(clean)) return section;
  return null;
}

function splitSections(lines: string[]): Map<Section, string[]> {
  const sections = new Map<Section, string[]>([['header', []]]);
  let current: Section = 'header';
  for (const line of lines) {
    const h = headingOf(line);
    if (h) {
      current = h;
      if (!sections.has(h)) sections.set(h, []);
      continue;
    }
    sections.get(current)!.push(line);
  }
  return sections;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function looksLikeName(line: string): boolean {
  if (/[\d@|,:/]/.test(line)) return false;
  const words = line.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[\p{L}][\p{L}.'-]*$/u.test(w));
}

function parseHeader(lines: string[], p: ProfileData): void {
  const nameIdx = lines.findIndex(looksLikeName);
  if (nameIdx >= 0) {
    const raw = lines[nameIdx];
    p.personal.fullName = raw === raw.toUpperCase() ? titleCase(raw) : raw;
  }
  for (const line of lines) {
    const email = line.match(EMAIL_RE);
    if (email && !p.personal.email) p.personal.email = email[0];
    const withoutEmails = line.replace(new RegExp(EMAIL_RE.source, 'gi'), ' ');
    const phone = withoutEmails.match(PHONE_RE);
    if (phone && !p.personal.phone && phone[1].replace(/\D/g, '').length >= 8) p.personal.phone = phone[1].trim();
    for (const url of withoutEmails.match(URL_RE) ?? []) {
      const clean = url.replace(/[).,]+$/, '');
      if (p.personal.links.some((l) => l.url === clean)) continue;
      const label = /linkedin\./i.test(clean) ? 'LinkedIn' : /github\./i.test(clean) ? 'GitHub' : 'Website';
      p.personal.links.push({ id: '', label, url: clean });
    }
  }
  const after = nameIdx >= 0 ? lines.slice(nameIdx + 1) : lines;
  const headline = after.find((l) => !/[\d@|,·]/.test(l) && l.split(/\s+/).length <= 8 && !URL_RE.test(l));
  URL_RE.lastIndex = 0;
  if (headline) p.headline = headline;
  const locLine = after.find((l) => l.includes(',') && !EMAIL_RE.test(l.split(SEPARATORS)[0]));
  if (locLine) {
    const loc = locLine.split(SEPARATORS)[0].trim();
    if (!EMAIL_RE.test(loc) && !/\d{3}/.test(loc)) {
      p.personal.location = loc;
      p.personal.country = loc.split(',').at(-1)!.trim();
    }
  }
}

function splitRoleLine(line: string): { title: string | null; company: string | null; location: string | null } {
  let parts: string[];
  if (/\s+at\s+/i.test(line) && !SEPARATORS.test(line)) parts = line.split(/\s+at\s+/i);
  else if (SEPARATORS.test(line)) parts = line.split(SEPARATORS);
  else {
    const i = line.indexOf(', ');
    parts = i > 0 ? [line.slice(0, i), line.slice(i + 2)] : [line];
  }
  parts = parts.map((s) => s.replace(/^[,|]+|[,|]+$/g, '').trim()).filter(Boolean);
  const title = parts[0] ?? null;
  let company = parts[1] ?? null;
  let location = parts[2] ?? null;
  if (company && !location && SEPARATORS.test(line)) {
    // "Title — Company, City": split a trailing city off the company when it is a single word.
    const m = company.match(/^(.*\S),\s*([\p{L} .'-]+)$/u);
    if (m && !/\(/.test(m[2]) && m[2].split(/\s+/).length <= 3) [company, location] = [m[1], m[2]];
  }
  return { title, company, location };
}

function parseExperience(lines: string[], p: ProfileData): void {
  let current: ProfileData['experience'][number] | null = null;
  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      const text = line.replace(BULLET_RE, '').trim();
      if (current && text) current.bullets.push({ id: '', text });
      continue;
    }
    const dated = parseDateRange(line);
    if (dated && !dated.rest && current) {
      current.startDate = dated.range.start;
      current.endDate = dated.range.end;
      current.current = dated.range.current;
      continue;
    }
    const role = splitRoleLine(dated ? dated.rest : line);
    if (!role.company && current) {
      current.summary = current.summary ? `${current.summary} ${line}` : line;
      continue;
    }
    current = {
      id: '',
      title: role.title,
      company: role.company,
      location: role.location,
      startDate: dated?.range.start ?? null,
      endDate: dated?.range.end ?? null,
      current: dated?.range.current ?? false,
      summary: null,
      bullets: [],
    };
    p.experience.push(current);
  }
}

const INSTITUTION = /universit|institut|college|school|academy|polytechnic|hochschule|école/i;

function parseEducation(lines: string[], p: ProfileData): void {
  for (const line of lines.filter((l) => !BULLET_RE.test(l))) {
    const dated = parseDateRange(line);
    const rest = dated ? dated.rest : line;
    let parts = rest.split(SEPARATORS);
    if (parts.length === 1) parts = rest.split(/,\s+/);
    parts = parts.map((s) => s.replace(/[,\s]+$/, '').trim()).filter(Boolean);
    const instIdx = parts.findIndex((s) => INSTITUTION.test(s));
    const institution = instIdx >= 0 ? parts[instIdx] : parts.length > 1 ? parts.at(-1)! : null;
    const degree = parts.filter((_, i) => i !== (instIdx >= 0 ? instIdx : parts.length - 1)).join(', ') || null;
    if (!institution && !degree) continue;
    p.education.push({
      id: '',
      institution,
      degree,
      field: null,
      startDate: dated?.range.start ?? null,
      endDate: dated?.range.end ?? null,
      grade: null,
    });
  }
}

function splitList(lines: string[]): string[] {
  return lines
    .flatMap((l) => l.replace(BULLET_RE, '').split(/\s*[,;•|·]\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 40);
}

export function heuristicExtract(text: string, now: Date = new Date()): ProfileData {
  const p = emptyProfile();
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const sections = splitSections(lines);

  parseHeader(sections.get('header') ?? [], p);
  const summary = sections.get('summary');
  if (summary?.length) p.summary = summary.join(' ');
  parseExperience(sections.get('experience') ?? [], p);
  parseEducation(sections.get('education') ?? [], p);

  const seen = new Set<string>();
  for (const name of splitList(sections.get('skills') ?? [])) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    p.skills.push({ id: '', name, category: 'skill' });
  }
  for (const line of sections.get('certifications') ?? []) {
    const name = line.replace(BULLET_RE, '').trim();
    if (name) p.certifications.push({ id: '', name, issuer: null, date: null });
  }
  for (const item of splitList(sections.get('languages') ?? [])) {
    const m = item.match(/^([^()]+?)\s*(?:\(([^)]+)\))?$/);
    if (m) p.languages.push({ id: '', name: m[1].trim(), proficiency: m[2]?.trim() ?? null });
  }
  for (const line of sections.get('projects') ?? []) {
    if (BULLET_RE.test(line)) {
      const last = p.projects.at(-1);
      if (last) last.bullets.push({ id: '', text: line.replace(BULLET_RE, '').trim() });
      continue;
    }
    const [name, ...desc] = line.split(SEPARATORS);
    if (name.trim()) p.projects.push({ id: '', name: name.trim(), description: desc.join(' — ').trim() || null, url: null, technologies: [], bullets: [] });
  }

  p.previousTitles = [...new Set(p.experience.map((e) => e.title).filter((t): t is string => !!t))];
  p.yearsExperience = computeYearsOfExperience(p, now);
  return ProfileDataSchema.parse(assignIds(sanitizeProfile(p)));
}
