import { and, count, desc, eq, gte, inArray, or } from 'drizzle-orm';
import type { Db } from '../db';
import { containsText } from '../db/search';
import { jobListings, jobs, matches, profiles, sources } from '../db/schema';
import { sourceLabel } from './links';

const DAY = 86_400_000;

export type JobState = 'new' | 'updated' | 'seen';

export interface JobListItem {
  id: number;
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  status: string;
  firstSeenAt: Date;
  lastChangedAt: Date;
  sources: string[];
  state: JobState;
}

/** "new" = first seen in the last 24 h; "updated" = content changed in the last 24 h. */
export function jobState(firstSeenAt: Date, lastChangedAt: Date, now: Date): JobState {
  if (now.getTime() - firstSeenAt.getTime() < DAY) return 'new';
  if (lastChangedAt.getTime() > firstSeenAt.getTime() && now.getTime() - lastChangedAt.getTime() < DAY) return 'updated';
  return 'seen';
}

export function listJobs(
  db: Db,
  opts: { q?: string; page?: number; pageSize?: number; includeExpired?: boolean; now?: Date } = {},
): { items: JobListItem[]; total: number; page: number; pageSize: number } {
  const now = opts.now ?? new Date();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const q = opts.q?.trim();
  const where = and(
    opts.includeExpired ? undefined : eq(jobs.status, 'active'),
    q ? or(containsText(jobs.title, q), containsText(jobs.company, q), containsText(jobs.location, q)) : undefined,
  );
  const total = db.select({ n: count() }).from(jobs).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.firstSeenAt), desc(jobs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const ids = rows.map((r) => r.id);
  const srcRows = ids.length
    ? db
        .selectDistinct({ jobId: jobListings.jobId, name: sources.name, url: jobListings.sourceUrl })
        .from(jobListings)
        .innerJoin(sources, eq(jobListings.sourceId, sources.id))
        .where(inArray(jobListings.jobId, ids))
        .all()
    : [];
  const byJob = new Map<number, string[]>();
  for (const r of srcRows) {
    const names = byJob.get(r.jobId) ?? [];
    const label = sourceLabel(r.name, r.url);
    if (!names.includes(label)) byJob.set(r.jobId, [...names, label]);
  }
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      company: r.company,
      location: r.location,
      workMode: r.workMode,
      employmentType: r.employmentType,
      salaryMin: r.salaryMin,
      salaryMax: r.salaryMax,
      salaryCurrency: r.salaryCurrency,
      salaryPeriod: r.salaryPeriod,
      status: r.status,
      firstSeenAt: r.firstSeenAt,
      lastChangedAt: r.lastChangedAt,
      sources: byJob.get(r.id) ?? [],
      state: jobState(r.firstSeenAt, r.lastChangedAt, now),
    })),
  };
}

export function getJob(db: Db, id: number) {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) return null;
  const listings = db
    .select({
      id: jobListings.id,
      sourceId: jobListings.sourceId,
      sourceName: sources.name,
      adapterId: sources.adapterId,
      sourceUrl: jobListings.sourceUrl,
      applicationUrl: jobListings.applicationUrl,
      applyEmail: jobListings.applyEmail,
      title: jobListings.title,
      company: jobListings.company,
      location: jobListings.location,
      salaryText: jobListings.salaryText,
      description: jobListings.description,
      postedAt: jobListings.postedAt,
      status: jobListings.status,
      firstSeenAt: jobListings.firstSeenAt,
      lastSeenAt: jobListings.lastSeenAt,
    })
    .from(jobListings)
    .innerJoin(sources, eq(jobListings.sourceId, sources.id))
    .where(eq(jobListings.jobId, id))
    .orderBy(jobListings.id)
    .all();
  // How it matched each profile (gate-filtered jobs too: the match page says why).
  const matched = db
    .select({ matchId: matches.id, profileName: profiles.name, score: matches.score, decision: matches.decision, method: matches.method, filterReason: matches.filterReason })
    .from(matches)
    .innerJoin(profiles, eq(matches.profileId, profiles.id))
    .where(eq(matches.jobId, id))
    .orderBy(profiles.id)
    .all();
  return { ...job, listings, matches: matched };
}

export function jobCounts(db: Db, now: Date = new Date()): { active: number; newToday: number } {
  const active = db.select({ n: count() }).from(jobs).where(eq(jobs.status, 'active')).get()?.n ?? 0;
  const newToday = db
    .select({ n: count() })
    .from(jobs)
    .where(and(eq(jobs.status, 'active'), gte(jobs.firstSeenAt, new Date(now.getTime() - DAY))))
    .get()?.n ?? 0;
  return { active, newToday };
}

/** Salary range for display, e.g. "₹12L–18L / year" style kept simple: "INR 1,200,000–1,800,000 / year". */
export function formatSalary(j: Pick<JobListItem, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>): string | null {
  if (!j.salaryMin) return null;
  const fmt = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n);
  const range = j.salaryMax && j.salaryMax !== j.salaryMin ? `${fmt(j.salaryMin)}–${fmt(j.salaryMax)}` : fmt(j.salaryMin);
  return `${j.salaryCurrency ?? ''} ${range}${j.salaryPeriod ? ` / ${j.salaryPeriod}` : ''}`.trim();
}

