import { createHash } from 'node:crypto';
import { resolvePlaces, type Places } from '../matching/geo';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Converts job-description HTML to readable plain text, keeping paragraphs and bullet points. */
/** Bytes 0x80–0x9F as Windows-1252 shows them (Latin-1 shows them as control characters). */
const CP1252_BYTES: Record<string, number> = {
  '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89,
  '\u0160': 0x8a, '\u2039': 0x8b, '\u0152': 0x8c, '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95,
  '\u2013': 0x96, '\u2014': 0x97, '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b, '\u0153': 0x9c, '\u017e': 0x9e, '\u0178': 0x9f,
};
const byteOf = (ch: string): number => {
  const c = ch.codePointAt(0)!;
  return c <= 0xff ? c : (CP1252_BYTES[ch] ?? -1);
};
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Repairs text that was UTF-8 but got decoded as Latin-1/Windows-1252 somewhere upstream ("Youâ€™ll" → "You’ll");
 * some job feeds send it like that. Only exact UTF-8 byte sequences are changed, so correct accented text stays.
 */
export function repairMojibake(input: string): string {
  if (!/[\u00c2-\u00f4]/.test(input)) return input;
  const chars = [...input];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const lead = byteOf(chars[i]);
    const need = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
    if (need) {
      const bytes = [lead, ...chars.slice(i + 1, i + 1 + need).map(byteOf)];
      if (bytes.length === need + 1 && bytes.slice(1).every((b) => b >= 0x80 && b <= 0xbf)) {
        try {
          out += strictUtf8.decode(Uint8Array.from(bytes));
          i += need;
          continue;
        } catch {
          // Not a valid sequence: keep the characters as they are.
        }
      }
    }
    out += chars[i];
  }
  return out;
}

const FORMAT_TAGS = 'script|style|noscript|p|div|span|ul|ol|li|br|hr|strong|b|em|i|u|s|a|font|small|sup|sub|h[1-6]|table|thead|tbody|tr|td|th|section|article|header|footer|blockquote|code|pre|img|label';
const FORMAT_TAG = new RegExp(`<\\/?(?:${FORMAT_TAGS})\\b[^<>]*>`, 'i');
/** A "<" that doesn't open a formatting tag. */
const NOT_A_FORMAT_TAG = new RegExp(`<(?!\\/?(?:${FORMAT_TAGS})\\b[^<>]*>)`, 'gi');

/** Tags to line breaks and bullets, everything else dropped (entities are left alone). */
function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

export function htmlToText(input: string): string {
  let html = input;
  // Some APIs (e.g. Greenhouse) send HTML that is itself entity-escaped.
  if (/&lt;[a-z/]/i.test(html) && !/<[a-z/]/i.test(html)) html = decodeEntities(html);
  let text = decodeEntities(stripTags(html));
  // Others mix the two (Arbeitnow: an escaped body, then a real-HTML footer): decoding uncovered more markup. Only
  // formatting tags are removed then; any other "<" is prose ("< 90k", "Result<T>", "<canvas>") and stays.
  if (FORMAT_TAG.test(text)) {
    const keep = '\u0000';
    text = decodeEntities(stripTags(text.replace(NOT_A_FORMAT_TAG, keep))).replaceAll(keep, '<');
  }
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean);
  // "<li><p>Text" leaves the bullet on a line of its own: keep it with its text.
  const out: string[] = [];
  for (const line of lines) {
    if (out.at(-1) !== '•') out.push(line);
    else if (line !== '•') out[out.length - 1] = `• ${line}`;
  }
  if (out.at(-1) === '•') out.pop();
  return out.join('\n');
}

/** "Austin, Austin, Texas," → "Austin, Texas": empty parts and immediate repeats dropped (some feeds pad locations). */
export function tidyLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());
  return kept.join(', ') || null;
}

const COMPANY_SUFFIXES = new Set(['incorporated', 'inc', 'llc', 'ltd', 'limited', 'pvt', 'private', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'oy', 'ab', 'as', 'co', 'corp', 'corporation', 'company', 'pty', 'kg', 'se', 'lp', 'llp']);

/** "Fictional Labs Pvt. Ltd." → "fictional labs". Legal forms are dropped only at the end ("AB InBev" keeps "ab"). */
export function normalizeCompany(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bl\.l\.c\b\.?/g, ' llc ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

const TITLE_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bsr\b/g, 'senior'],
  [/\bsnr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\bjnr\b/g, 'junior'],
  [/\bmgr\b/g, 'manager'],
  [/\bdev\b/g, 'developer'],
  [/\bengg\b/g, 'engineer'],
  [/\beng\b/g, 'engineer'],
  [/\bassoc\b/g, 'associate'],
  [/\bexec\b/g, 'executive'],
  [/\bvp\b/g, 'vice president'],
];

export function normalizeTitle(title: string): string {
  let t = title
    .toLowerCase()
    .replace(/\((?:m|f|w|d|x|h|all)(?:\s*\/\s*(?:m|f|w|d|x|h|all))+\)/g, ' ') // (m/f/d)
    .replace(/[-–—|,]?\s*(?:req(?:uisition)?\.?\s*(?:id)?|job\s*id|ref)\s*[:#]?\s*[\w-]*\d[\w-]*/g, ' ')
    .replace(/#\s*\d+/g, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ');
  for (const [re, full] of TITLE_ABBREVIATIONS) t = t.replace(re, full);
  return t.trim().replace(/\s+/g, ' ');
}

export function fingerprint(company: string, title: string): string {
  return createHash('sha1').update(`${normalizeCompany(company)}|${normalizeTitle(title)}`).digest('hex').slice(0, 20);
}

const GENERIC_PLACE_WORDS = new Set(['remote', 'hybrid', 'onsite', 'on', 'site', 'anywhere', 'worldwide', 'global', 'the', 'and', 'or', 'office', 'hq', 'new', 'san', 'united', 'north', 'south', 'east', 'west', 'st', 'city', 'area', 'region', 'greater', 'metro', 'based', 'in', 'of']);
const placeWords = (loc: string) => new Set(loc.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2 && !GENERIC_PLACE_WORDS.has(w)));
const intersects = <T>(a: Set<T>, b: Set<T>) => [...a].some((x) => b.has(x));

/**
 * Two listings of the same company+title are the same job only if their locations are compatible:
 * a missing location matches anything; otherwise cities must overlap (or, without cities, countries).
 */
export function locationsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return true;
  const pa = resolvePlaces(a);
  const pb = resolvePlaces(b);
  const known = (p: Places) => p.cities.size + p.countries.size > 0;
  if (known(pa) && known(pb)) {
    if (pa.cities.size && pb.cities.size) return intersects(pa.cities, pb.cities);
    return intersects(pa.countries, pb.countries);
  }
  // At least one side names no known place: a plain "Remote"/"Anywhere" matches; unknown place names must agree.
  const unknownA = placeWords(a);
  const unknownB = placeWords(b);
  if (!known(pa) && unknownA.size === 0) return true;
  if (!known(pb) && unknownB.size === 0) return true;
  if (known(pa) !== known(pb)) return false;
  const union = new Set([...unknownA, ...unknownB]).size;
  return [...unknownA].filter((w) => unknownB.has(w)).length / union >= 0.5;
}

export type WorkMode = 'remote' | 'hybrid' | 'onsite';

export function detectWorkMode(...texts: Array<string | null | undefined>): WorkMode | null {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (!t) return null;
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bremote\b|work from home|\bwfh\b|work from anywhere|fully distributed|\btelecommut/.test(t)) return 'remote';
  if (/\bon-?site\b|\bin[- ]office\b|office[- ]based|\bin[- ]person\b/.test(t)) return 'onsite';
  return null;
}

export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary';

export function detectEmploymentType(...texts: Array<string | null | undefined>): EmploymentType | null {
  const t = texts.filter(Boolean).join(' ').toLowerCase().replace(/[_-]/g, ' ');
  if (/\bintern(ship)?\b|\btrainee\b|\bwerkstudent/.test(t)) return 'internship';
  if (/\bpart ?time\b/.test(t)) return 'part-time';
  if (/\bcontract(or)?\b|\bfreelance\b|\bconsultant\b/.test(t)) return 'contract';
  if (/\btemp(orary)?\b|\bseasonal\b|\bfixed term\b/.test(t)) return 'temporary';
  if (/\bfull ?time\b|\bpermanent\b/.test(t)) return 'full-time';
  return null;
}

export interface Salary {
  min: number;
  max: number;
  currency: string | null;
  period: 'year' | 'month' | 'week' | 'day' | 'hour';
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/₹|\binr\b|\brs\.?\s|\blpa\b|\blakh/i, 'INR'],
  [/€|\beur\b/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
  [/\bcad\b|c\$/i, 'CAD'],
  [/\baud\b|a\$/i, 'AUD'],
  [/\$|\busd\b/i, 'USD'],
];

/** Parses free-text salary ("$120K–$150K", "₹12–18 LPA", "£25 per hour"). Null when no numbers are present. */
export function parseSalaryText(text: string | null | undefined): Salary | null {
  if (!text) return null;
  const t = text.replace(/,(?=\d{3})/g, '');
  const lakhs = /\blpa\b|\blakhs?\b|\blac\b/i.test(t);
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([kKmM])?(?![\d])/g)]
    .map((m) => {
      let n = Number(m[1]);
      const unit = m[2]?.toLowerCase();
      if (unit === 'k') n *= 1_000;
      if (unit === 'm') n *= 1_000_000;
      if (lakhs && !unit) n *= 100_000;
      return n;
    })
    .filter((n) => n > 0);
  if (nums.length === 0) return null;
  const period = /per hour|\/\s*h(ou)?r|hourly/i.test(t)
    ? 'hour'
    : /per day|\/\s*day|daily/i.test(t)
      ? 'day'
      : /per week|weekly/i.test(t)
        ? 'week'
        : /per month|\/\s*mo(nth)?|monthly/i.test(t)
          ? 'month'
          : 'year';
  const currency = CURRENCY_SYMBOLS.find(([re]) => re.test(t))?.[1] ?? null;
  return { min: Math.min(...nums.slice(0, 2)), max: Math.max(...nums.slice(0, 2)), currency, period };
}

export function descriptionHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const APPLY_CONTEXT = /\b(apply|application|send|email|e-mail|mail|submit|forward)\b[^.\n]{0,80}$/i;
const NON_APPLY = /^(no-?reply|privacy|gdpr|dpo|legal|abuse|support|info@.*privacy|unsubscribe|security)/i;

/** Returns the address a job asks candidates to email their application to, if any. */
export function extractApplyEmail(text: string): string | null {
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase().replace(/\.$/, '');
    if (NON_APPLY.test(email)) continue;
    const before = text.slice(Math.max(0, m.index! - 120), m.index);
    if (APPLY_CONTEXT.test(before) && /\b(cv|resume|résumé|application|apply)\b/i.test(before + text.slice(m.index!, m.index! + 60))) return email;
  }
  return null;
}

function shingles(text: string, size = 3): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  if (out.size === 0 && words.length) out.add(words.join(' '));
  return out;
}

/** Jaccard similarity of word 3-shingles (0–1). */
export function textSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  // Nothing to compare is not evidence of sameness.
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const LEVEL_WORDS = new Set(['senior', 'junior', 'lead', 'principal', 'staff', 'head', 'intern', 'chief', 'director', 'associate', 'i', 'ii', 'iii', 'iv', 'v', 'vice', 'entry', 'graduate', 'trainee']);

/** The seniority words of a title ("senior", "ii"…): postings differing here are different jobs. */
export function titleLevel(title: string): string {
  return [...new Set(normalizeTitle(title).split(' ').filter((w) => LEVEL_WORDS.has(w)))].sort().join(' ');
}

/** Company names that don't identify an employer and must never be used to merge jobs. */
export function isPlaceholderCompany(company: string): boolean {
  return /^(unknown|confidential|undisclosed|n\/?a|stealth|private|anonymous|hiring company|company)( company)?$/i.test(company.trim());
}
