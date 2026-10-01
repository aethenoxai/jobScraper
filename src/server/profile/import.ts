import { normalizeCompany, normalizeTitle } from '../jobs/normalize';
import type { ProfileData } from './model';

type Bullet = { id: string; text: string };
type WithId = { id: string };

/** Reuses ids of bullets whose text is unchanged, and keeps the user's own lines the new CV lacks. */
function mergeBullets(current: Bullet[], incoming: Bullet[], usedIds: Set<string>): Bullet[] {
  const merged = incoming.map((b) => {
    const match = current.find((c) => c.text.trim() === b.text.trim() && !usedIds.has(c.id));
    const id = match ? match.id : usedIds.has(b.id) ? '' : b.id;
    if (id) usedIds.add(id);
    return { id, text: b.text };
  });
  const incomingTexts = new Set(incoming.map((b) => b.text.trim()));
  const kept = current.filter((b) => !incomingTexts.has(b.text.trim()) && !usedIds.has(b.id));
  for (const b of kept) usedIds.add(b.id);
  return [...merged, ...kept];
}

/** Takes the new CV's list, but matched items keep their id (and bullets) so tailored CVs can still cite them. */
function mergeList<T extends WithId>(current: T[], incoming: T[], key: (item: T) => string, mergeItem?: (cur: T, inc: T, usedIds: Set<string>) => T): T[] {
  const used = new Set<string>();
  const usedBullets = new Set<string>();
  return incoming.map((inc) => {
    // Each current item's id can be reused once (e.g. two stints at the same employer stay distinct).
    const cur = current.find((c) => key(c) === key(inc) && !used.has(c.id));
    if (!cur) return used.has(inc.id) ? { ...inc, id: '' } : inc;
    used.add(cur.id);
    return mergeItem ? { ...mergeItem(cur, inc, usedBullets), id: cur.id } : { ...inc, id: cur.id };
  });
}

const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

type Getter = (p: ProfileData) => unknown;
type Setter = (target: ProfileData, source: ProfileData) => void;

const scalar = (label: string, get: Getter, set: Setter) => ({ label, get, set });

/** Top-level pieces of a profile that a re-uploaded CV can replace, one decision each. */
export const IMPORT_FIELDS: Record<string, { label: string; get: Getter; set: Setter }> = {
  'personal.fullName': scalar('Name', (p) => p.personal.fullName, (t, s) => (t.personal.fullName = s.personal.fullName)),
  'personal.email': scalar('Email', (p) => p.personal.email, (t, s) => (t.personal.email = s.personal.email)),
  'personal.phone': scalar('Phone', (p) => p.personal.phone, (t, s) => (t.personal.phone = s.personal.phone)),
  'personal.location': scalar('Location', (p) => p.personal.location, (t, s) => (t.personal.location = s.personal.location)),
  'personal.country': scalar('Country', (p) => p.personal.country, (t, s) => (t.personal.country = s.personal.country)),
  'personal.links': scalar('Links', (p) => p.personal.links, (t, s) => {
    t.personal.links = mergeList(t.personal.links, s.personal.links, (l) => lc(l.url));
  }),
  headline: scalar('Current title', (p) => p.headline, (t, s) => (t.headline = s.headline)),
  summary: scalar('Summary', (p) => p.summary, (t, s) => (t.summary = s.summary)),
  industry: scalar('Industry', (p) => p.industry, (t, s) => (t.industry = s.industry)),
  domain: scalar('Domain', (p) => p.domain, (t, s) => (t.domain = s.domain)),
  yearsExperience: scalar('Years of experience', (p) => p.yearsExperience, (t, s) => (t.yearsExperience = s.yearsExperience)),
  careerLevel: scalar('Career level', (p) => p.careerLevel, (t, s) => (t.careerLevel = s.careerLevel)),
  previousTitles: scalar('Previous titles', (p) => p.previousTitles, (t, s) => (t.previousTitles = s.previousTitles)),
  experience: scalar('Work experience', (p) => p.experience, (t, s) => {
    t.experience = mergeList(t.experience, s.experience, (e) => `${normalizeCompany(e.company ?? '')}|${normalizeTitle(e.title ?? '')}`, (cur, inc, used) => ({ ...inc, bullets: mergeBullets(cur.bullets, inc.bullets, used) }));
  }),
  education: scalar('Education', (p) => p.education, (t, s) => {
    t.education = mergeList(t.education, s.education, (e) => `${lc(e.institution)}|${lc(e.degree)}`);
  }),
  certifications: scalar('Certifications', (p) => p.certifications, (t, s) => {
    t.certifications = mergeList(t.certifications, s.certifications, (c) => lc(c.name));
  }),
  skills: scalar('Skills', (p) => p.skills, (t, s) => {
    t.skills = mergeList(t.skills, s.skills, (x) => lc(x.name));
  }),
  projects: scalar('Projects', (p) => p.projects, (t, s) => {
    t.projects = mergeList(t.projects, s.projects, (x) => lc(x.name), (cur, inc, used) => ({ ...inc, bullets: mergeBullets(cur.bullets, inc.bullets, used) }));
  }),
  languages: scalar('Languages', (p) => p.languages, (t, s) => {
    t.languages = mergeList(t.languages, s.languages, (x) => lc(x.name));
  }),
};

export interface ImportChange {
  key: string;
  label: string;
  current: string;
  incoming: string;
  /** Pre-select only when it fills something empty; replacing existing data is the user's call. */
  recommended: boolean;
}

/** Strips ids so lists compare by content. */
const withoutIds = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(withoutIds)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id').map(([k, x]) => [k, withoutIds(x)]))
      : v;

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';

function describeItem(item: unknown): string {
  if (typeof item === 'string') return item;
  const o = item as Record<string, unknown>;
  const head =
    o.title !== undefined || o.company !== undefined
      ? [o.title, o.company].filter(Boolean).join(' @ ')
      : String(o.name ?? o.institution ?? o.url ?? o.label ?? '');
  const bullets = Array.isArray(o.bullets) ? (o.bullets as Bullet[]).map((b) => b.text) : [];
  return bullets.length ? `${head}: ${bullets.join('; ')}` : head;
}

function describe(v: unknown): string {
  if (isEmpty(v)) return '—';
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}: ${v.map(describeItem).filter(Boolean).join(' | ')}`;
  return String(v);
}

export function diffProfile(current: ProfileData, incoming: ProfileData): ImportChange[] {
  const changes: ImportChange[] = [];
  for (const [key, f] of Object.entries(IMPORT_FIELDS)) {
    const a = f.get(current);
    const b = f.get(incoming);
    if (isEmpty(b)) continue; // never propose clearing data the new CV simply lacks
    if (JSON.stringify(withoutIds(a)) === JSON.stringify(withoutIds(b))) continue;
    changes.push({ key, label: f.label, current: describe(a), incoming: describe(b), recommended: isEmpty(a) });
  }
  return changes;
}

export function applyImport(current: ProfileData, incoming: ProfileData, accepted: string[]): ProfileData {
  const result = structuredClone(current);
  for (const key of accepted) IMPORT_FIELDS[key]?.set(result, structuredClone(incoming));
  return result;
}
