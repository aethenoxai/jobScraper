import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ai } from '../ai';
import type { Db } from '../db';
import { containsText } from '../db/search';
import { applicationEvents, applications, jobListings, jobs, matches, sources } from '../db/schema';
import type { Logger } from '../logging';
import type { ProfileRecord, ProfileService } from '../profile/service';
import type { Queue } from '../queue';
import { sourceLabel } from '../jobs/links';
import { analyzeJob, type AnalysisResult } from './analysis';
import { evaluateMatch, heuristicEvaluate, profileItems, type Evaluation, type RequirementEvaluation } from './evaluate';
import { applyGates, targetTitles } from './gates';
import { languagesIn, postingLanguage } from './language';
import { computeScore, decide, profileSeniority, seniorityGap, type ScoreResult } from './score';
import { interpretSlider } from './slider';

export const PREPARE_TASK = 'application.prepare';

/** Approving a job that is no longer listed (it expired or was taken down). */
export class JobClosedError extends Error {
  override name = 'JobClosedError';
}
/** Skip the AI when the offline pre-score is this far below the threshold: it cannot plausibly reach it. */
const AI_PRESCORE_MARGIN = 25;
/** Jobs paying below the user's minimum salary are kept below every threshold (shown only in "Filtered out"). */
const SALARY_CAP = 65;
const DAY_MS = 86_400_000;
const ATS_ADAPTERS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'manual']);

export const BreakdownSchema = z.object({
  gate: z.string().optional(),
  score: z.custom<ScoreResult>().optional(),
  evaluation: z.custom<Evaluation>().optional(),
  analysis: z.custom<Pick<AnalysisResult, 'yearsExperienceMin' | 'seniority' | 'summary' | 'method'>>().optional(),
});
export type Breakdown = z.infer<typeof BreakdownSchema>;

export interface EvaluateResult {
  matchId: number;
  score: number;
  decision: 'surfaced' | 'filtered';
  newlySurfaced: boolean;
  skipped?: boolean;
}

const YEAR_FACTOR: Record<string, number> = { year: 1, month: 12, week: 48, day: 230, hour: 2000 };

function salaryFit(job: typeof jobs.$inferSelect, profile: ProfileRecord): number {
  const min = profile.preferences.salaryMin;
  if (!min || !job.salaryMax) return 1;
  if (profile.preferences.salaryCurrency && job.salaryCurrency && profile.preferences.salaryCurrency !== job.salaryCurrency) return 1;
  const yearly = job.salaryMax * (YEAR_FACTOR[job.salaryPeriod ?? 'year'] ?? 1);
  return yearly < min ? 0.3 : 1;
}

/** Version of what matching depends on (profile data + preferences, not the slider): a stable 32-bit hash. */
export function profileVersion(profile: Pick<ProfileRecord, 'data' | 'preferences'>): number {
  // Contact details don't affect matching: editing them must not re-match (and re-spend AI on) every job.
  const { location, country } = profile.data.personal;
  const text = JSON.stringify([{ ...profile.data, personal: { location, country } }, profile.preferences]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * A posting written in another language (Portuguese, German, …) usually needs someone who works in it. When the
 * profile clearly lacks that language, an unmet must-have is added (it caps the score). Speaking it adds nothing:
 * it must never make up for requirements that aren't met. Without languages in the profile nothing is assumed.
 */
function postingLanguageGap(description: string, profile: ProfileRecord, analysis: AnalysisResult): RequirementEvaluation | null {
  const language = postingLanguage(description);
  // A posting that states its languages has said what it needs (and those are judged with the rest).
  if (!language || analysis.requirements.some((r) => r.kind === 'language') || !profile.data.languages.length) return null;
  const spoken = new Set(profile.data.languages.flatMap((l) => [...languagesIn(l.name), l.name]));
  const own = postingLanguage(profileItems(profile.data).map((i) => i.text).concat(profile.data.summary ?? '').join('\n'), { opening: false });
  if (spoken.has(language.name) || spoken.has(language.native) || own?.name === language.name) return null;
  return { text: `${language.name} (${language.native}): the posting is written in ${language.name}`, kind: 'language', mandatory: true, status: 'unmet', evidence: [], note: `${language.name} is not among the languages in your profile` };
}

/** Why a filtered job is filtered after the slider moved: still naming what limited its score (salary, a must-have). */
function filterReasonFor(m: { filterReason: string | null; breakdown: unknown }, d: ReturnType<typeof decide>): string | null {
  if (d.decision === 'surfaced') return null;
  if (m.filterReason?.startsWith('Pays below')) return m.filterReason;
  const score = BreakdownSchema.safeParse(m.breakdown).data?.score;
  return `${d.reason}${score?.cappedBy && score.capKind === 'requirement' ? ` (limited by: ${score.cappedBy})` : ''}`;
}

export type MatchService = ReturnType<typeof createMatchService>;

/** Offline-scored matches are offered to the AI again at most this often (a broken key or provider can't loop). */
const OFFLINE_RETRY_MS = 6 * 3_600_000;

export function createMatchService(deps: { db: Db; ai: Ai | null; queue: Queue; profiles: ProfileService; log: Logger; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const listingsFor = (jobId: number) =>
    db
      .select({
        id: jobListings.id,
        sourceId: jobListings.sourceId,
        sourceName: sources.name,
        adapterId: sources.adapterId,
        sourceUrl: jobListings.sourceUrl,
        applicationUrl: jobListings.applicationUrl,
        applyEmail: jobListings.applyEmail,
        description: jobListings.description,
        descriptionHash: jobListings.descriptionHash,
        title: jobListings.title,
        status: jobListings.status,
        firstSeenAt: jobListings.firstSeenAt,
      })
      .from(jobListings)
      .innerJoin(sources, eq(jobListings.sourceId, sources.id))
      .where(eq(jobListings.jobId, jobId))
      .orderBy(asc(jobListings.id))
      .all();

  /** The listing to apply through by default: the company's own board, then one with an email, then the newest. */
  /** The fullest description among a job's listings (and its cache key for the analysis). */
  function jobText(job: typeof jobs.$inferSelect): { description: string; descriptionHash: string } {
    const listing = listingsFor(job.id).sort((a, b) => b.description.length - a.description.length)[0];
    return { description: listing?.description ?? '', descriptionHash: listing?.descriptionHash ?? `job-${job.id}` };
  }

  function preferredListing(jobId: number) {
    const ls = listingsFor(jobId).filter((l) => l.status === 'active');
    return ls.find((l) => ATS_ADAPTERS.has(l.adapterId)) ?? ls.find((l) => l.applyEmail) ?? ls.at(-1) ?? listingsFor(jobId).at(-1);
  }

  type UpsertResult = { score: number; decision: 'surfaced' | 'filtered'; reason: string | null; method: 'ai' | 'heuristic' | 'gate'; breakdown: Breakdown };

  /**
   * Saves a match. `redecide` gives the decision for another slider value: the slider may have moved while the job
   * was being evaluated, and the saved decision must follow the slider as it is now.
   */
  function upsert(evaluated: ProfileRecord, job: typeof jobs.$inferSelect, scored: UpsertResult, redecide?: (sliderValue: number) => Pick<UpsertResult, 'decision' | 'reason'>): EvaluateResult {
    return db.transaction(() => write(evaluated, job, scored, redecide), { behavior: 'immediate' });
  }

  function write(evaluated: ProfileRecord, job: typeof jobs.$inferSelect, scored: UpsertResult, redecide?: (sliderValue: number) => Pick<UpsertResult, 'decision' | 'reason'>): EvaluateResult {
    const sliderValue = deps.profiles.get(evaluated.id)?.sliderValue ?? evaluated.sliderValue;
    const result = redecide && sliderValue !== evaluated.sliderValue ? { ...scored, ...redecide(sliderValue) } : scored;
    // The profile data as evaluated (if it changed meanwhile, the match stays stale and is redone).
    const profile = { ...evaluated, sliderValue };
    const t = now();
    const existing = db.select().from(matches).where(and(eq(matches.profileId, profile.id), eq(matches.jobId, job.id))).get();
    const values = {
      score: result.score,
      decision: result.decision,
      filterReason: result.reason,
      method: result.method,
      breakdown: result.breakdown,
      sliderValue: profile.sliderValue,
      jobVersion: job.lastChangedAt.getTime(),
      profileVersion: profileVersion(profile),
      evaluatedAt: t,
    };
    // "New" means surfaced for the very first time and not yet reviewed: re-crossing the threshold never re-alerts.
    const newlySurfaced = result.decision === 'surfaced' && !existing?.firstSurfacedAt && (!existing || existing.reviewState === 'NEW');
    if (existing) {
      db.update(matches)
        .set({ ...values, firstSurfacedAt: existing.firstSurfacedAt ?? (result.decision === 'surfaced' ? t : null) })
        .where(eq(matches.id, existing.id))
        .run();
      return { matchId: existing.id, score: result.score, decision: result.decision, newlySurfaced };
    }
    const row = db
      .insert(matches)
      .values({ ...values, profileId: profile.id, jobId: job.id, reviewState: 'NEW', firstSurfacedAt: result.decision === 'surfaced' ? t : null })
      .onConflictDoUpdate({ target: [matches.profileId, matches.jobId], set: values })
      .returning({ id: matches.id })
      .get();
    return { matchId: row.id, score: result.score, decision: result.decision, newlySurfaced };
  }

  const service = {
    listingsFor,

    /** Gates → cached JD analysis → requirement evaluation → score → decision. Skips work already done. */
    async evaluate(jobId: number, profileId: number, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<EvaluateResult> {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      const profile = deps.profiles.get(profileId);
      if (!job || !profile) throw new Error('Job or profile not found');
      const existing = db.select().from(matches).where(and(eq(matches.profileId, profileId), eq(matches.jobId, jobId))).get();
      // Offline-scored matches are redone once an AI provider is available (e.g. after the daily budget resets).
      const upgrade = existing?.method === 'heuristic' && !!deps.ai?.status().configured;
      if (!opts.force && !upgrade && existing && existing.jobVersion === job.lastChangedAt.getTime() && existing.profileVersion === profileVersion(profile)) {
        if (existing.sliderValue === profile.sliderValue || existing.method === 'gate') {
          return { matchId: existing.id, score: existing.score, decision: existing.decision, newlySurfaced: false, skipped: true };
        }
        // Only the slider moved: re-decide from the stored score, no re-evaluation.
        const d = decide(existing.score, profile.sliderValue);
        const t = now();
        db.update(matches)
          .set({ decision: d.decision, filterReason: filterReasonFor(existing, d), sliderValue: profile.sliderValue, firstSurfacedAt: existing.firstSurfacedAt ?? (d.decision === 'surfaced' ? t : null) })
          .where(eq(matches.id, existing.id))
          .run();
        return { matchId: existing.id, score: existing.score, decision: d.decision, newlySurfaced: d.decision === 'surfaced' && !existing.firstSurfacedAt && existing.reviewState === 'NEW', skipped: true };
      }
      const { description, descriptionHash } = jobText(job);
      const gate = applyGates({ ...job, description }, profile);
      if (!gate.pass) return upsert(profile, job, { score: 0, decision: 'filtered', reason: gate.reason ?? 'Filtered', method: 'gate', breakdown: { gate: gate.reason } });

      const analysis = await analyzeJob({ title: job.title, description, descriptionHash }, { db, ai: deps.ai, now, signal: opts.signal });
      const base = {
        yearsRequired: analysis.yearsExperienceMin,
        profileYears: profile.data.yearsExperience,
        locationFit: gate.locationFit,
        salaryFit: salaryFit(job, profile),
        seniorityGap: seniorityGap(analysis.seniority, profileSeniority(profile.data)),
      };
      const threshold = interpretSlider(profile.sliderValue).matchThreshold;
      let evaluation = heuristicEvaluate(analysis, profile.data, gate.titleFit);
      const prescore = computeScore({ ...base, evaluation }).score;
      if (prescore >= threshold - AI_PRESCORE_MARGIN) {
        evaluation = await evaluateMatch(analysis, profile.data, gate.titleFit, { ai: deps.ai, jobTitle: job.title, targetTitles: targetTitles(profile), signal: opts.signal });
      }
      const gap = postingLanguageGap(description, profile, analysis);
      if (gap) evaluation = { ...evaluation, requirements: [...evaluation.requirements, gap], gaps: [...evaluation.gaps, gap.note!] };
      const score = computeScore({ ...base, evaluation });
      const underpaid = base.salaryFit < 1;
      if (underpaid) score.score = Math.min(score.score, SALARY_CAP);
      const decideAt = (sliderValue: number) => {
        const d = decide(score.score, sliderValue);
        // Say what held the score down (e.g. a language the profile lacks), not only that it is below the threshold.
        const limit = score.cappedBy && score.capKind === 'requirement' ? ` (limited by: ${score.cappedBy})` : '';
        return { decision: d.decision, reason: underpaid && d.decision === 'filtered' ? `Pays below your minimum salary (${score.score}%)` : d.reason ? `${d.reason}${limit}` : null };
      };
      return upsert(
        profile,
        job,
        {
          score: score.score,
          ...decideAt(profile.sliderValue),
          method: evaluation.method,
          breakdown: { score, evaluation, analysis: { yearsExperienceMin: analysis.yearsExperienceMin, seniority: analysis.seniority, summary: analysis.summary, method: analysis.method } },
        },
        decideAt,
      );
    },

    /** After a slider change: recompute decisions from stored scores (no AI). */
    redecide(profileId: number): { newlySurfaced: number[] } {
      const profile = deps.profiles.get(profileId);
      if (!profile) return { newlySurfaced: [] };
      const newlySurfaced: number[] = [];
      const t = now();
      db.transaction(
        (tx) => {
          const rows = tx
            .select({ m: matches, jobStatus: jobs.status })
            .from(matches)
            .innerJoin(jobs, eq(matches.jobId, jobs.id))
            .where(and(eq(matches.profileId, profileId), ne(matches.method, 'gate')))
            .all();
          for (const { m, jobStatus } of rows) {
            const d = decide(m.score, profile.sliderValue);
            // A job no longer listed is never announced (nor marked as announced, in case it comes back).
            const surfacesNow = d.decision === 'surfaced' && jobStatus === 'active';
            if (surfacesNow && !m.firstSurfacedAt && m.reviewState === 'NEW') newlySurfaced.push(m.id);
            tx.update(matches)
              .set({ decision: d.decision, filterReason: filterReasonFor(m, d), sliderValue: profile.sliderValue, firstSurfacedAt: m.firstSurfacedAt ?? (surfacesNow ? t : null) })
              .where(eq(matches.id, m.id))
              .run();
          }
        },
        { behavior: 'immediate' },
      );
      return { newlySurfaced };
    },

    view(matchId: number): void {
      db.update(matches).set({ reviewState: 'VIEWED' }).where(and(eq(matches.id, matchId), eq(matches.reviewState, 'NEW'))).run();
    },

    /** Skips a job not yet decided on; false if there was nothing to skip (unknown, approved or already skipped). */
    skip(matchId: number): boolean {
      return db.update(matches).set({ reviewState: 'SKIPPED' }).where(and(eq(matches.id, matchId), inArray(matches.reviewState, ['NEW', 'VIEWED']))).run().changes > 0;
    },

    undoSkip(matchId: number): void {
      db.update(matches).set({ reviewState: 'VIEWED' }).where(and(eq(matches.id, matchId), eq(matches.reviewState, 'SKIPPED'))).run();
    },

    /**
     * Approves a match: creates (or returns) the application for the chosen listing and queues its preparation.
     * This is the only place applications are created (N1). Each listing may get its own application (N11).
     */
    approve(matchId: number, listingId?: number, origin: 'user' | 'telegram' = 'user') {
      const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
      if (!match) throw new Error('Match not found');
      const listing = listingId ? listingsFor(match.jobId).find((l) => l.id === listingId) : preferredListing(match.jobId);
      if (!listing) throw new Error('This job has no listing to apply through');
      const job = db.select().from(jobs).where(eq(jobs.id, match.jobId)).get()!;
      const already = db.select().from(applications).where(and(eq(applications.profileId, match.profileId), eq(applications.listingId, listing.id))).get();
      // Approving again is fine; starting an application for a posting that has closed is not.
      if (!already && (job.status !== 'active' || listing.status !== 'active')) throw new JobClosedError('This job is no longer listed.');
      const t = now();
      let isNew = false;
      const app = db.transaction(
        (tx) => {
          const existing = tx.select().from(applications).where(and(eq(applications.profileId, match.profileId), eq(applications.listingId, listing.id))).get();
          tx.update(matches).set({ reviewState: 'APPROVED' }).where(eq(matches.id, matchId)).run();
          if (existing) return existing;
          isNew = true;
          const created = tx
            .insert(applications)
            .values({
              profileId: match.profileId,
              jobId: match.jobId,
              listingId: listing.id,
              matchId,
              jobTitle: job.title,
              company: job.company,
              location: job.location,
              sourceName: listing.sourceName,
              sourceUrl: listing.sourceUrl,
              applicationUrl: listing.applicationUrl,
              applyEmail: listing.applyEmail,
              method: listing.applyEmail ? 'email' : 'browser',
              status: 'PREPARING',
              approvedAt: t,
              createdAt: t,
              updatedAt: t,
            })
            .returning()
            .get();
          tx.insert(applicationEvents)
            .values({ applicationId: created.id, type: 'approved', origin: 'user', message: `Approved${origin === 'telegram' ? ' from Telegram' : ''} (match ${match.score}%) via ${sourceLabel(listing.sourceName, listing.sourceUrl)}`, occurredAt: t })
            .run();
          return created;
        },
        { behavior: 'immediate' },
      );
      // Approving again (UI and Telegram) never regenerates a package that exists.
      if (isNew) deps.queue.enqueue(PREPARE_TASK, { applicationId: app.id }, { dedupeKey: `${PREPARE_TASK}:${app.id}` });
      return app;
    },

    get(matchId: number) {
      const m = db.select().from(matches).where(eq(matches.id, matchId)).get();
      if (!m) return null;
      const job = db.select().from(jobs).where(eq(jobs.id, m.jobId)).get()!;
      const apps = db.select().from(applications).where(and(eq(applications.profileId, m.profileId), eq(applications.jobId, m.jobId))).all();
      const breakdown = BreakdownSchema.safeParse(m.breakdown);
      return { ...m, breakdown: breakdown.success ? breakdown.data : {}, job, listings: listingsFor(m.jobId), applications: apps };
    },

    feed(
      profileId: number,
      opts: {
        view?: 'surfaced' | 'filtered';
        state?: 'NEW' | 'VIEWED' | 'APPROVED' | 'SKIPPED' | 'pending';
        minScore?: number;
        workMode?: string;
        q?: string;
        /** Only jobs listed on this source. */
        sourceId?: number;
        /** Only jobs first found within this many days. */
        foundWithinDays?: number;
        /** "new": surfaced in the last 24 hours; "updated": changed since first found, in the last 7 days. */
        fresh?: 'new' | 'updated';
        sort?: 'score' | 'date';
        page?: number;
        pageSize?: number;
      },
    ) {
      const pageSize = Math.min(Math.max(opts.pageSize ?? 30, 1), 100);
      const page = Math.max(opts.page ?? 1, 1);
      const conds: Array<SQL | undefined> = [
        eq(matches.profileId, profileId),
        eq(matches.decision, opts.view ?? 'surfaced'),
        eq(jobs.status, 'active'),
        opts.state === 'pending'
          ? inArray(matches.reviewState, ['NEW', 'VIEWED'])
          : opts.state
            ? eq(matches.reviewState, opts.state)
            : ne(matches.reviewState, 'SKIPPED'),
        opts.minScore ? gte(matches.score, opts.minScore) : undefined,
        opts.workMode ? eq(jobs.workMode, opts.workMode as 'remote') : undefined,
        opts.q ? or(containsText(jobs.title, opts.q), containsText(jobs.company, opts.q)) : undefined,
        opts.sourceId ? inArray(jobs.id, db.select({ id: jobListings.jobId }).from(jobListings).where(eq(jobListings.sourceId, opts.sourceId))) : undefined,
        opts.foundWithinDays ? gte(jobs.firstSeenAt, new Date(now().getTime() - opts.foundWithinDays * DAY_MS)) : undefined,
        opts.fresh === 'new' ? gte(matches.firstSurfacedAt, new Date(now().getTime() - DAY_MS)) : undefined,
        opts.fresh === 'updated' ? and(gt(jobs.lastChangedAt, jobs.firstSeenAt), gte(jobs.lastChangedAt, new Date(now().getTime() - 7 * DAY_MS))) : undefined,
      ];
      const where = and(...conds);
      const total = db.select({ n: count() }).from(matches).innerJoin(jobs, eq(matches.jobId, jobs.id)).where(where).get()?.n ?? 0;
      const rows = db
        .select({ match: matches, job: jobs })
        .from(matches)
        .innerJoin(jobs, eq(matches.jobId, jobs.id))
        .where(where)
        .orderBy(...(opts.sort === 'date' ? [desc(jobs.firstSeenAt)] : [desc(matches.score), desc(jobs.firstSeenAt)]))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      const jobIds = rows.map((r) => r.job.id);
      const srcRows = jobIds.length
        ? db.selectDistinct({ jobId: jobListings.jobId, name: sources.name, url: jobListings.sourceUrl }).from(jobListings).innerJoin(sources, eq(jobListings.sourceId, sources.id)).where(inArray(jobListings.jobId, jobIds)).all()
        : [];
      const appRows = jobIds.length ? db.select().from(applications).where(and(eq(applications.profileId, profileId), inArray(applications.jobId, jobIds))).all() : [];
      return {
        total,
        page,
        pageSize,
        items: rows.map(({ match, job }) => ({
          matchId: match.id,
          jobId: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          workMode: job.workMode,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          salaryCurrency: job.salaryCurrency,
          salaryPeriod: job.salaryPeriod,
          score: match.score,
          reviewState: match.reviewState,
          filterReason: match.filterReason,
          method: match.method,
          firstSeenAt: job.firstSeenAt,
          lastChangedAt: job.lastChangedAt,
          firstSurfacedAt: match.firstSurfacedAt,
          sources: [...new Set(srcRows.filter((s) => s.jobId === job.id).map((s) => sourceLabel(s.name, s.url)))],
          applicationStatus: appRows.find((a) => a.jobId === job.id)?.status ?? null,
        })),
      };
    },

    /** PRD §39 dashboard numbers for one profile (or all profiles). */
    counts(profileId?: number, at: Date = now()) {
      const byProfile = profileId ? eq(matches.profileId, profileId) : undefined;
      const active = and(byProfile, eq(matches.decision, 'surfaced'), eq(jobs.status, 'active'));
      const c = (where: SQL | undefined) => db.select({ n: count() }).from(matches).innerJoin(jobs, eq(matches.jobId, jobs.id)).where(where).get()?.n ?? 0;
      const appCounts = db
        .select({ status: applications.status, n: count() })
        .from(applications)
        .where(profileId ? eq(applications.profileId, profileId) : undefined)
        .groupBy(applications.status)
        .all();
      const apps = Object.fromEntries(appCounts.map((r) => [r.status, r.n])) as Record<string, number>;
      // Applied at some point: still open, or since rejected/withdrawn after applying.
      const submitted =
        db
          .select({ n: count() })
          .from(applications)
          .where(and(profileId ? eq(applications.profileId, profileId) : undefined, or(isNotNull(applications.submittedAt), inArray(applications.status, ['APPLIED', 'INTERVIEW', 'OFFER']))))
          .get()?.n ?? 0;
      return {
        // Skipped jobs are hidden from the feed, so they are not counted either.
        newMatches: c(and(active, ne(matches.reviewState, 'SKIPPED'), gte(matches.firstSurfacedAt, new Date(at.getTime() - DAY_MS)))),
        matching: c(and(active, ne(matches.reviewState, 'SKIPPED'))),
        awaitingApproval: c(and(active, inArray(matches.reviewState, ['NEW', 'VIEWED']))),
        preparing: apps.PREPARING ?? 0,
        ready: apps.READY ?? 0,
        submitted,
        interviews: apps.INTERVIEW ?? 0,
        offers: apps.OFFER ?? 0,
        rejected: apps.REJECTED ?? 0,
        failed: (apps.PREPARATION_FAILED ?? 0) + (apps.APPLICATION_FAILED ?? 0) + (apps.APPLICATION_SKIPPED ?? 0),
      };
    },

    /** The fullest description of a job (e.g. for a cover letter). */
    descriptionFor(jobId: number): string {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      return job ? jobText(job).description : '';
    },

    /** The (cached) requirement analysis of a job, e.g. for tailoring a CV to it. */
    async analysisFor(jobId: number, signal?: AbortSignal): Promise<AnalysisResult | null> {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) return null;
      const { description, descriptionHash } = jobText(job);
      return analyzeJob({ title: job.title, description, descriptionHash }, { db, ai: deps.ai, now, signal });
    },

    activeJobIds(): number[] {
      return db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'active')).orderBy(desc(jobs.firstSeenAt)).all().map((r) => r.id);
    },

    /** Active jobs whose match for this profile is missing or out of date (reconciliation after crashes/changes). */
    /**
     * Jobs scored offline (no AI, or the day's budget was used up) that are worth a second look now that AI is
     * available: those that could pass the threshold, not retried in the last few hours (a failing key can't loop).
     */
    offlineScoredJobIds(profileId: number, limit = 500): number[] {
      const st = deps.ai?.status();
      if (!st?.configured || (st.dailyBudgetUsd !== null && st.spentTodayUsd >= st.dailyBudgetUsd)) return [];
      const profile = deps.profiles.get(profileId);
      if (!profile) return [];
      const threshold = interpretSlider(profile.sliderValue).matchThreshold;
      const retryAfter = new Date(now().getTime() - OFFLINE_RETRY_MS);
      return db
        .select({ id: jobs.id })
        .from(matches)
        .innerJoin(jobs, eq(matches.jobId, jobs.id))
        .where(and(eq(matches.profileId, profileId), eq(matches.method, 'heuristic'), eq(jobs.status, 'active'), gte(matches.score, threshold - 25), lt(matches.evaluatedAt, retryAfter)))
        .orderBy(desc(matches.score))
        .limit(limit)
        .all()
        .map((r) => r.id);
    },

    staleJobIds(profileId: number, limit = 5000): number[] {
      const profile = deps.profiles.get(profileId);
      if (!profile) return [];
      const version = profileVersion(profile);
      return db
        .select({ id: jobs.id })
        .from(jobs)
        .leftJoin(matches, and(eq(matches.jobId, jobs.id), eq(matches.profileId, profileId)))
        .where(and(eq(jobs.status, 'active'), or(sql`${matches.id} is null`, sql`${matches.jobVersion} <> ${jobs.lastChangedAt}`, ne(matches.profileVersion, version))))
        .limit(limit)
        .all()
        .map((r) => r.id);
    },
  };
  return service;
}
