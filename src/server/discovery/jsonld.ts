import { detectEmploymentType, htmlToText } from '../jobs/normalize';
import type { RawListing } from '../sources/types';

type Json = Record<string, unknown>;

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

function isJobPosting(node: Json): boolean {
  return asArray(node['@type'] as string | string[]).some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
}

function collect(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Json;
  if (isJobPosting(obj)) out.push(obj);
  if (obj['@graph']) collect(obj['@graph'], out);
}

function locationOf(p: Json): string | null {
  const parts = asArray(p.jobLocation as Json | Json[]).map((loc) => {
    const a = (loc?.address ?? loc) as Json;
    if (typeof a === 'string') return a;
    return [str(a.addressLocality), str(a.addressRegion), str((a.addressCountry as Json)?.name ?? a.addressCountry)].filter(Boolean).join(', ');
  });
  return parts.filter(Boolean).join(' / ') || null;
}

function salaryOf(p: Json): string | null {
  const s = p.baseSalary as Json | undefined;
  if (!s || typeof s !== 'object') return null;
  const v = (s.value ?? {}) as Json;
  const min = str(v.minValue ?? v.value);
  if (!min) return null;
  const max = str(v.maxValue) ?? min;
  const unit = (str(v.unitText) ?? 'YEAR').toLowerCase();
  return `${str(s.currency) ?? ''} ${min} - ${max} per ${unit}`.trim();
}

/** An absolute http(s) address for a link that may be relative to the page. */
function absolute(v: unknown, pageUrl: string): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s, pageUrl);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** A posting's own id when it has one (identifier, its own URL), otherwise its title, company and location. */
function identityOf(p: Json, pageUrl: string, title: string, company: string): string {
  const id = p.identifier;
  const own = str(typeof id === 'object' && id !== null ? (id as Json).value ?? (id as Json).name : id);
  if (own) return `${pageUrl}#id:${own}`;
  const url = absolute(p.url, pageUrl);
  if (url && url !== pageUrl) return url;
  return `${pageUrl}#${[title, company, locationOf(p) ?? ''].join('|').toLowerCase().replace(/\s+/g, ' ')}`;
}

function date(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extracts schema.org JobPosting entries embedded as JSON-LD (what career sites publish for Google Jobs). */
export function extractJobPostings(html: string, pageUrl: string): RawListing[] {
  const postings: Json[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collect(JSON.parse(m[1].trim()), postings);
    } catch {
      // Invalid JSON-LD blocks are common; skip them.
    }
  }
  return postings.flatMap((p) => {
    const title = str(p.title);
    const org = p.hiringOrganization;
    const company = typeof org === 'string' ? org : str((org as Json | undefined)?.name);
    if (!title || !company) return [];
    const remote = asArray(p.jobLocationType as string | string[]).some((x) => /telecommute/i.test(String(x)));
    return [
      {
        sourceJobId: postings.length > 1 ? identityOf(p, pageUrl, title, company) : pageUrl,
        sourceUrl: absolute(p.url, pageUrl) ?? pageUrl,
        applicationUrl: absolute((p.directApply as Json | undefined)?.url, pageUrl) ?? absolute(p.url, pageUrl) ?? pageUrl,
        title: htmlToText(title),
        company: htmlToText(company),
        location: locationOf(p),
        workMode: remote ? ('remote' as const) : null,
        employmentType: detectEmploymentType(...asArray(p.employmentType as string | string[]).map(String)),
        salaryText: salaryOf(p),
        description: htmlToText(str(p.description) ?? ''),
        postedAt: date(p.datePosted),
        expiresAt: date(p.validThrough),
      },
    ];
  });
}
