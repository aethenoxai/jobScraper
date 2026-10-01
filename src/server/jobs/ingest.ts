import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, notInArray, notLike } from 'drizzle-orm';
import type { Db } from '../db';
import { jobListings, jobs, sources } from '../db/schema';
import { RawListingSchema, type RawListing } from '../sources/types';
import {
  isPlaceholderCompany,
  titleLevel,
  descriptionHash,
  detectEmploymentType,
  detectWorkMode,
  extractApplyEmail,
  fingerprint,
  locationsCompatible,
  normalizeCompany,
  normalizeTitle,
  parseSalaryText,
  repairMojibake,
  textSimilarity,
  tidyLocation,
} from './normalize';

export interface IngestStats {
  found: number;
  newListings: number;
  newJobs: number;
  updated: number;
  unchanged: number;
  expired: number;
  parseErrors: number;
}

export interface IngestResult {
  stats: IngestStats;
  /** Canonical jobs that are new or whose content changed: these need (re-)matching. */
  changedJobIds: number[];
}

/** A complete-snapshot source must miss a listing this many successful runs in a row before it expires. */
export const MISSES_BEFORE_EXPIRY = 3;
/** Listings from partial sources expire after this long unseen. */
export const UNSEEN_EXPIRY_MS = 30 * 86_400_000;
const FUZZY_WINDOW_MS = 60 * 86_400_000;
const FUZZY_TITLE_MIN = 0.5;
const FUZZY_DESCRIPTION_MIN = 0.7;
/** Short texts (snippets, empty descriptions) can't show two postings are the same. */
const FUZZY_MIN_TEXT = 150;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ParsedListing = ReturnType<typeof RawListingSchema.parse>;

const titleTokens = (t: string) => new Set(normalizeTitle(t).split(' ').filter(Boolean));
/** Jaccard overlap of normalized title words (0–1). */
function titleOverlap(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const union = new Set([...ta, ...tb]).size;
  if (union === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / union;
}

export function createIngestor(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const contentHash = (l: { title: string; description: string }) => descriptionHash(`${l.title}\n${l.description}`);

  function jobFields(l: ParsedListing, description: string) {
    const salary = parseSalaryText(l.salaryText);
    return {
      title: l.title,
      company: l.company,
      // Kept in step with the title and company, so other sources' listings still find this job after a rename.
      fingerprint: fingerprint(l.company, l.title),
      companyKey: normalizeCompany(l.company),
      location: l.location ?? null,
      workMode: l.workMode ?? detectWorkMode(l.location, l.title, description.slice(0, 2000)),
      employmentType: l.employmentType ?? detectEmploymentType(l.title),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      salaryPeriod: salary?.period ?? null,
    };
  }

  /**
   * Finds the canonical job a new listing belongs to: exact fingerprint first, then fuzzy within the company.
   * Never merges two postings from the same source (they are separate openings), jobs long gone, or jobs of
   * placeholder companies. A source that repeats postings (`mergeRepeats`, e.g. mirror sites) has its exact repeats
   * merged: same title, company, location and text.
   */
  function findCanonical(tx: Tx, sourceId: number, l: ParsedListing, description: string, t: Date, mergeRepeats = false): (typeof jobs.$inferSelect) | null {
    if (isPlaceholderCompany(l.company)) return null;
    const recent = new Date(t.getTime() - FUZZY_WINDOW_MS);
    const fromThisSource = (jobId: number) => tx.select({ hash: jobListings.descriptionHash }).from(jobListings).where(and(eq(jobListings.jobId, jobId), eq(jobListings.sourceId, sourceId))).all();
    const usable = (j: typeof jobs.$inferSelect) => (j.status === 'active' || j.lastSeenAt >= recent) && locationsCompatible(j.location, l.location) && fromThisSource(j.id).length === 0;

    const exact = tx.select().from(jobs).where(eq(jobs.fingerprint, fingerprint(l.company, l.title))).all();
    const hit = exact.find(usable);
    if (hit) return hit;
    if (mergeRepeats && description.length >= FUZZY_MIN_TEXT) {
      const hash = contentHash({ title: l.title, description });
      const repeat = exact.find((j) => j.status === 'active' && (j.location ?? null) === (l.location ?? null) && fromThisSource(j.id).some((x) => x.hash === hash));
      if (repeat) return repeat;
    }

    if (description.length < FUZZY_MIN_TEXT) return null;
    const level = titleLevel(l.title);
    const candidates = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.companyKey, normalizeCompany(l.company)), gte(jobs.lastSeenAt, recent)))
      .orderBy(desc(jobs.lastSeenAt))
      .limit(25)
      .all();
    for (const c of candidates) {
      if (titleLevel(c.title) !== level || titleOverlap(c.title, l.title) < FUZZY_TITLE_MIN || !usable(c)) continue;
      const texts = tx.select({ description: jobListings.description }).from(jobListings).where(eq(jobListings.jobId, c.id)).limit(3).all();
      if (texts.some((x) => x.description.length >= FUZZY_MIN_TEXT && textSimilarity(x.description, description) >= FUZZY_DESCRIPTION_MIN)) return c;
    }
    return null;
  }

  function refreshJobStatus(tx: Tx, jobIds: number[], t: Date): void {
    for (const jobId of jobIds) {
      const active = tx.select({ id: jobListings.id }).from(jobListings).where(and(eq(jobListings.jobId, jobId), eq(jobListings.status, 'active'))).get();
      tx.update(jobs).set({ status: active ? 'active' : 'expired' }).where(eq(jobs.id, jobId)).run();
      if (active) tx.update(jobs).set({ lastSeenAt: t }).where(and(eq(jobs.id, jobId), lt(jobs.lastSeenAt, t))).run();
    }
  }

  return {
    /** Listings a source needn't send in full again. Those whose text was pruned (gone for months) are not among them. */
    knownIds(sourceId: number): Set<string> {
      return new Set(db.select({ id: jobListings.sourceJobId }).from(jobListings).where(and(eq(jobListings.sourceId, sourceId), notLike(jobListings.descriptionHash, 'pruned:%'))).all().map((r) => r.id));
    },

    /** Stores one successful source run. Never call it for a failed run: absence would wrongly expire listings. */
    ingestRun(sourceId: number, raw: RawListing[], opts: { completeSnapshot: boolean; mergeRepeats?: boolean }): IngestResult {
      const t = now();
      const stats: IngestStats = { found: raw.length, newListings: 0, newJobs: 0, updated: 0, unchanged: 0, expired: 0, parseErrors: 0 };
      const changed = new Set<number>();
      const touchedJobs = new Set<number>();
      const seenIds: string[] = [];
      // Jobs the user added stay until they remove them, whatever expiry date their page carries.
      const manual = db.select({ adapterId: sources.adapterId }).from(sources).where(eq(sources.id, sourceId)).get()?.adapterId === 'manual';
      const pastExpiry = (d: Date | null | undefined) => !manual && !!d && d.getTime() <= t.getTime();

      db.transaction(
        (tx) => {
          for (const item of raw) {
            const parsed = RawListingSchema.safeParse(item);
            if (!parsed.success) {
              stats.parseErrors++;
              continue;
            }
            // Some feeds send UTF-8 that was decoded twice ("Youâ€™ll"): repaired once here, for every source.
            const fix = (v: string | null | undefined) => (typeof v === 'string' ? repairMojibake(v) : v);
            const l = { ...parsed.data, title: repairMojibake(parsed.data.title), company: repairMojibake(parsed.data.company), location: tidyLocation(fix(parsed.data.location)), salaryText: fix(parsed.data.salaryText), description: fix(parsed.data.description) };
            if (seenIds.includes(l.sourceJobId)) continue;
            seenIds.push(l.sourceJobId);
            const existing = tx
              .select()
              .from(jobListings)
              .where(and(eq(jobListings.sourceId, sourceId), eq(jobListings.sourceJobId, l.sourceJobId)))
              .get();

            if (existing && l.touchOnly) {
              tx.update(jobListings).set({ status: pastExpiry(existing.expiresAt) ? 'expired' : 'active', missedRuns: 0, lastSeenAt: t }).where(eq(jobListings.id, existing.id)).run();
              touchedJobs.add(existing.jobId);
              stats.unchanged++;
              continue;
            }
            if (!existing && l.touchOnly) continue;

            if (existing) {
              const description = l.description ?? existing.description;
              const hash = contentHash({ title: l.title, description });
              const materialChange =
                hash !== existing.descriptionHash ||
                (l.location ?? null) !== existing.location ||
                (l.salaryText ?? null) !== existing.salaryText ||
                (l.workMode ?? null) !== existing.workMode ||
                (l.employmentType ?? null) !== existing.employmentType;
              tx.update(jobListings)
                .set({
                  ...(materialChange
                    ? {
                        title: l.title,
                        company: l.company,
                        location: l.location ?? null,
                        workMode: l.workMode ?? null,
                        employmentType: l.employmentType ?? null,
                        salaryText: l.salaryText ?? null,
                        description,
                        descriptionHash: hash,
                        applyEmail: l.applyEmail ?? extractApplyEmail(description),
                        lastChangedAt: t,
                      }
                    : {}),
                  sourceUrl: l.sourceUrl,
                  applicationUrl: l.applicationUrl ?? existing.applicationUrl,
                  expiresAt: l.expiresAt ?? existing.expiresAt,
                  // Still listed but past its own expiry date: it stays closed (and isn't re-matched every scan).
                  status: pastExpiry(l.expiresAt ?? existing.expiresAt) ? 'expired' : 'active',
                  missedRuns: 0,
                  lastSeenAt: t,
                })
                .where(eq(jobListings.id, existing.id))
                .run();
              touchedJobs.add(existing.jobId);
              const closed = pastExpiry(l.expiresAt ?? existing.expiresAt);
              if (materialChange) {
                stats.updated++;
                if (!closed) changed.add(existing.jobId);
                tx.update(jobs).set({ ...jobFields(l, description), lastChangedAt: t }).where(eq(jobs.id, existing.jobId)).run();
              } else {
                stats.unchanged++;
                // Back after expiring: its old match may say "no longer listed", so it is a change worth re-matching.
                if (existing.status === 'expired' && !closed) {
                  changed.add(existing.jobId);
                  tx.update(jobs).set({ lastChangedAt: t }).where(eq(jobs.id, existing.jobId)).run();
                }
              }
              continue;
            }

            const description = l.description ?? '';
            const canonical = findCanonical(tx, sourceId, l, description, t, opts.mergeRepeats);
            let jobId = canonical?.id ?? null;
            // A new listing that revives an expired job makes it worth matching again.
            if (canonical && canonical.status === 'expired' && !pastExpiry(l.expiresAt)) {
              changed.add(canonical.id);
              tx.update(jobs).set({ lastChangedAt: t }).where(eq(jobs.id, canonical.id)).run();
            }
            if (jobId === null) {
              jobId = tx
                .insert(jobs)
                .values({
                  ...jobFields(l, description),
                  status: 'active',
                  firstSeenAt: t,
                  lastSeenAt: t,
                  lastChangedAt: t,
                })
                .returning({ id: jobs.id })
                .get().id;
              stats.newJobs++;
              if (!pastExpiry(l.expiresAt)) changed.add(jobId);
            }
            tx.insert(jobListings)
              .values({
                jobId,
                sourceId,
                sourceJobId: l.sourceJobId,
                sourceUrl: l.sourceUrl,
                applicationUrl: l.applicationUrl ?? null,
                applyEmail: l.applyEmail ?? extractApplyEmail(description),
                title: l.title,
                company: l.company,
                location: l.location ?? null,
                workMode: l.workMode ?? null,
                employmentType: l.employmentType ?? null,
                salaryText: l.salaryText ?? null,
                description,
                descriptionHash: contentHash({ title: l.title, description }),
                postedAt: l.postedAt ?? null,
                expiresAt: l.expiresAt ?? null,
                status: pastExpiry(l.expiresAt) ? 'expired' : 'active',
                missedRuns: 0,
                firstSeenAt: t,
                lastSeenAt: t,
                lastChangedAt: t,
              })
              .run();
            stats.newListings++;
            touchedJobs.add(jobId);
          }

          if (opts.completeSnapshot) {
            const absent = tx
              .select()
              .from(jobListings)
              .where(and(eq(jobListings.sourceId, sourceId), eq(jobListings.status, 'active'), seenIds.length ? notInArray(jobListings.sourceJobId, seenIds) : undefined))
              .all();
            for (const a of absent) {
              const missed = a.missedRuns + 1;
              const expire = missed >= MISSES_BEFORE_EXPIRY;
              tx.update(jobListings).set({ missedRuns: missed, status: expire ? 'expired' : 'active' }).where(eq(jobListings.id, a.id)).run();
              if (expire) {
                stats.expired++;
                touchedJobs.add(a.jobId);
              }
            }
          }
          refreshJobStatus(tx, [...touchedJobs], t);
        },
        { behavior: 'immediate' },
      );
      return { stats, changedJobIds: [...changed] };
    },

    /**
     * Expires listings past their expiry date or unseen for 30 days. The age rule is skipped for complete-snapshot
     * sources (they expire by absence from successful runs) and for jobs the user added by hand.
     */
    expireStale(excludeFromAgeRule: Set<number> = new Set()): number {
      const t = now();
      const manualIds = db.select({ id: sources.id }).from(sources).where(eq(sources.adapterId, 'manual')).all().map((r) => r.id);
      const exempt = [...excludeFromAgeRule, ...manualIds];
      return db.transaction(
        (tx) => {
          const stale = tx
            .select({ id: jobListings.id, jobId: jobListings.jobId })
            .from(jobListings)
            .where(
              and(
                ne(jobListings.status, 'expired'),
                // Either past its own expiry date, or not seen for the unseen window.
                inArray(
                  jobListings.id,
                  tx
                    .select({ id: jobListings.id })
                    .from(jobListings)
                    .where(and(isNotNull(jobListings.expiresAt), lte(jobListings.expiresAt, t), manualIds.length ? notInArray(jobListings.sourceId, manualIds) : undefined))
                    .union(
                      tx
                        .select({ id: jobListings.id })
                        .from(jobListings)
                        .where(and(lt(jobListings.lastSeenAt, new Date(t.getTime() - UNSEEN_EXPIRY_MS)), exempt.length ? notInArray(jobListings.sourceId, exempt) : undefined)),
                    ),
                ),
              ),
            )
            .all();
          for (const s of stale) tx.update(jobListings).set({ status: 'expired' }).where(eq(jobListings.id, s.id)).run();
          refreshJobStatus(tx, [...new Set(stale.map((s) => s.jobId))], t);
          return stale.length;
        },
        { behavior: 'immediate' },
      );
    },
  };
}

export type Ingestor = ReturnType<typeof createIngestor>;
