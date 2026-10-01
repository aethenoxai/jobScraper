import { eq } from 'drizzle-orm';
import type { Ai } from '../ai';
import type { Db } from '../db';
import type { FailureLog } from '../failures';
import { scanRuns, sourceRuns, sources } from '../db/schema';
import type { HttpClient } from '../http';
import { UNSEEN_EXPIRY_MS, type Ingestor } from '../jobs/ingest';
import { plural } from '../../lib/format';
import { scrubSecrets, type Logger } from '../logging';
import { getAdapter } from '../sources/registry';
import type { SourceRecord, SourceService } from '../sources/service';
import { SourceError, type PageFetcher, type RawListing, type SourceHints } from '../sources/types';

export interface ScanOptions {
  db: Db;
  sources: SourceService;
  ingestor: Ingestor;
  http: HttpClient;
  /** Reads web pages for page-reading sources (web discovery); missing when Scrapling isn't set up. */
  pages?: PageFetcher;
  log: Logger;
  env: Record<string, string | undefined>;
  ai: Ai | null;
  hints: SourceHints;
  trigger: 'schedule' | 'manual';
  signal: AbortSignal;
  now?: () => Date;
  concurrency?: number;
  sourceTimeoutMs?: number;
  /** Called with canonical jobs that are new or changed (they need matching). */
  onChangedJobs?: (jobIds: number[]) => void;
  /** Called once when a source has failed SOURCE_ALERT_AFTER times in a row; `disabled` if it was switched off. */
  onSourceFailing?: (source: SourceRecord, error: string, disabled: boolean) => void;
  /** Where scan-wide problems are recorded for the System page (JOB_DISCOVERY_FAILED, JOB_PARSE_FAILED). */
  failures?: FailureLog;
}

export interface ScanSummary {
  scanRunId: number;
  /** skipped: nothing was due (every source checked recently) or no source is on. */
  status: 'success' | 'partial' | 'failed' | 'skipped';
  stats: { sources: number; skipped: number; failed: number; found: number; newJobs: number; newListings: number; updated: number; expired: number };
}

const MAX_LISTINGS_PER_SOURCE = 5000;
/** A source is reported to the user when it has failed this many runs in a row. */
const SOURCE_ALERT_AFTER = 3;
/** Discovered boards that fail this many runs in a row are disabled. */
export const DISCOVERED_FAILURE_LIMIT = 3;
/** At most this many new boards per web-discovery run. */
const MAX_REGISTRATIONS_PER_RUN = 10;

type Outcome = { kind: 'skipped'; dueAt?: Date } | { kind: 'failed' } | { kind: 'ok'; found: number; newJobs: number; newListings: number; updated: number; expired: number; changed: number[] };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  const now = opts.now ?? (() => new Date());
  const { db } = opts;
  const scanRunId = db.insert(scanRuns).values({ trigger: opts.trigger, status: 'running', startedAt: now() }).returning({ id: scanRuns.id }).get().id;
  const enabled = opts.sources.list().filter((s) => s.enabled);

  const setSource = (id: number, values: Partial<typeof sources.$inferInsert>) => db.update(sources).set(values).where(eq(sources.id, id)).run();

  async function runSource(source: SourceRecord): Promise<Outcome> {
    const adapter = getAdapter(source.adapterId);
    const started = now();
    // A cancelled scan leaves the remaining sources untouched (not a failure, no "last run").
    if (opts.signal.aborted) return { kind: 'skipped' };
    const skip = (reason: string): Outcome => {
      db.insert(sourceRuns).values({ scanRunId, sourceId: source.id, status: 'skipped', startedAt: started, finishedAt: started, error: reason }).run();
      setSource(source.id, { lastStatus: 'skipped', lastError: reason });
      return { kind: 'skipped' };
    };
    if (!adapter) return skip(`This source type (${source.adapterId}) is no longer available.`);
    const missing = (adapter.requiresEnv ?? []).filter((k) => !opts.env[k]);
    if (missing.length) return skip(`Add ${missing.join(' and ')} to your .env file to use ${adapter.displayName}.`);
    if (source.notBefore && source.notBefore > started) {
      // The source asked us to back off (Retry-After).
      return { kind: 'skipped', dueAt: source.notBefore };
    }
    if (source.lastRunAt && started.getTime() - source.lastRunAt.getTime() < adapter.minIntervalMinutes * 60_000) {
      // Not recorded as a run: politeness to the source, not an event the user needs to see.
      return { kind: 'skipped', dueAt: new Date(source.lastRunAt.getTime() + adapter.minIntervalMinutes * 60_000) };
    }

    let registered = 0;
    const runId = db.insert(sourceRuns).values({ scanRunId, sourceId: source.id, status: 'running', startedAt: started }).returning({ id: sourceRuns.id }).get().id;
    setSource(source.id, { lastRunAt: started });
    const timeout = AbortSignal.timeout(opts.sourceTimeoutMs ?? 5 * 60_000);
    const signal = AbortSignal.any([opts.signal, timeout]);
    try {
      const config = adapter.configSchema.safeParse(source.config);
      if (!config.success) throw new SourceError('SOURCE_CONFIG', `Invalid configuration: ${config.error.issues[0]?.message ?? 'check the source settings'}`);
      const listings: RawListing[] = [];
      let truncated = false;
      const iterate = async () => {
        for await (const l of adapter.fetch({
          config: config.data,
          http: opts.http,
          pages: opts.pages,
          log: opts.log.child({ source: source.name }),
          signal,
          hints: opts.hints,
          knownIds: opts.ingestor.knownIds(source.id),
          env: opts.env,
          ai: opts.ai,
          registerSource: (adapterId, name, cfg) => {
            if (registered >= MAX_REGISTRATIONS_PER_RUN) return;
            try {
              if (opts.sources.registerDiscovered(adapterId, name, cfg)) registered++;
            } catch (err) {
              opts.log.debug({ err, adapterId }, 'could not register discovered source');
            }
          },
        })) {
          listings.push(l);
          if (listings.length >= MAX_LISTINGS_PER_SOURCE) {
            truncated = true;
            break;
          }
        }
      };
      // Race the fetch against the timeout so an adapter that ignores its signal can't hang the scan.
      await Promise.race([
        iterate(),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new SourceError('SOURCE_UNAVAILABLE', timeout.aborted ? 'Source timed out' : 'Scan cancelled')), { once: true })),
      ]);
      // A cut-short list is not a complete snapshot: absence must not expire anything.
      const result = opts.ingestor.ingestRun(source.id, listings, { completeSnapshot: adapter.completeSnapshot && !truncated, mergeRepeats: adapter.repeatsPostings });
      const s = result.stats;
      db.update(sourceRuns)
        .set({ status: 'success', finishedAt: now(), found: s.found, newListings: s.newListings, newJobs: s.newJobs, updated: s.updated, unchanged: s.unchanged, expired: s.expired, parseErrors: s.parseErrors })
        .where(eq(sourceRuns.id, runId))
        .run();
      setSource(source.id, { lastStatus: 'success', lastSuccessAt: now(), lastError: null, consecutiveFailures: 0, notBefore: null });
      if (s.parseErrors) opts.failures?.record('JOB_PARSE_FAILED', `${plural(s.parseErrors, 'listing')} couldn't be read and ${s.parseErrors === 1 ? 'was' : 'were'} left out; ${s.found - s.parseErrors} ${s.found - s.parseErrors === 1 ? 'was' : 'were'} kept.`, source.name);
      // Hand over right away, so a crash later in the scan can't leave these jobs unmatched.
      if (result.changedJobIds.length) opts.onChangedJobs?.(result.changedJobIds);
      return { kind: 'ok', found: s.found, newJobs: s.newJobs, newListings: s.newListings, updated: s.updated, expired: s.expired, changed: result.changedJobIds };
    } catch (err) {
      if (opts.signal.aborted) {
        db.update(sourceRuns).set({ status: 'skipped', finishedAt: now(), error: 'Cancelled' }).where(eq(sourceRuns.id, runId)).run();
        // lastRunAt stays: the request had already gone to the source, and its minimum interval must hold.
        setSource(source.id, { lastStatus: 'skipped', lastError: 'Stopped before it finished' });
        return { kind: 'skipped' };
      }
      const e = SourceError.from(err);
      const message = scrubSecrets(e.message).slice(0, 500);
      db.update(sourceRuns).set({ status: 'failed', finishedAt: now(), errorCode: e.code, error: message }).where(eq(sourceRuns.id, runId)).run();
      const failures = source.consecutiveFailures + 1;
      // Boards added automatically by web discovery are switched off when they keep failing.
      const autoDisable = source.origin === 'discovered' && failures >= DISCOVERED_FAILURE_LIMIT;
      setSource(source.id, {
        lastStatus: 'failed',
        lastError: autoDisable ? `${message} (disabled after ${failures} failures in a row)` : message,
        consecutiveFailures: failures,
        notBefore: e.retryAfterMs ? new Date(now().getTime() + e.retryAfterMs) : null,
        ...(autoDisable ? { enabled: false } : {}),
      });
      opts.log.warn({ source: source.name, code: e.code, error: message }, 'source failed');
      firstError ??= `${source.name}: ${message}`;
      if (failures === SOURCE_ALERT_AFTER) opts.onSourceFailing?.(source, message, autoDisable);
      return { kind: 'failed' };
    }
  }

  let firstError: string | undefined;
  const outcomes = await mapLimit(enabled, opts.concurrency ?? 4, runSource);
  // Complete-snapshot boards expire listings by absence, but only while they work: a board that has failed
  // for the whole unseen window falls back to the age rule so its listings don't stay open forever.
  const t = now();
  const completeSources = new Set(
    enabled
      .filter((s) => getAdapter(s.adapterId)?.completeSnapshot)
      .filter((s) => {
        const last = opts.sources.get(s.id)?.lastSuccessAt;
        return !!last && t.getTime() - last.getTime() < UNSEEN_EXPIRY_MS;
      })
      .map((s) => s.id),
  );
  const expired = opts.ingestor.expireStale(completeSources);
  const ok = outcomes.filter((o): o is Extract<Outcome, { kind: 'ok' }> => o.kind === 'ok');
  const failed = outcomes.filter((o) => o.kind === 'failed').length;
  const stats = {
    sources: enabled.length,
    skipped: outcomes.filter((o) => o.kind === 'skipped').length,
    failed,
    found: ok.reduce((a, o) => a + o.found, 0),
    newJobs: ok.reduce((a, o) => a + o.newJobs, 0),
    newListings: ok.reduce((a, o) => a + o.newListings, 0),
    updated: ok.reduce((a, o) => a + o.updated, 0),
    expired: ok.reduce((a, o) => a + o.expired, 0) + expired,
  };
  // Nothing ran: say why instead of a "success" that found nothing.
  const dueTimes = outcomes.flatMap((o) => (o.kind === 'skipped' && o.dueAt ? [o.dueAt.getTime()] : []));
  const nothingRan = ok.length === 0 && failed === 0;
  const note = !nothingRan
    ? null
    : enabled.length === 0
      ? 'No job sources are turned on.'
      : dueTimes.length
        ? `Every source was checked recently; the next one is due at ${new Date(Math.min(...dueTimes)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
        : 'No source could run (see the Job sources page).';
  // Stopped part-way (the worker stopping, or the scan's time limit): what was read is kept, but it isn't a success.
  const stopped = opts.signal.aborted;
  const status: ScanSummary['status'] = stopped ? (ok.length > 0 ? 'partial' : 'failed') : nothingRan ? 'skipped' : failed === 0 ? 'success' : ok.length > 0 ? 'partial' : 'failed';
  const error = [stopped ? 'Stopped before it finished; the remaining sources are checked next time.' : null, failed ? `${failed} source(s) failed` : null].filter(Boolean).join(' ') || (stopped ? null : note);
  db.update(scanRuns)
    .set({ status, finishedAt: now(), stats: { ...stats, new: stats.newJobs }, error })
    .where(eq(scanRuns.id, scanRunId))
    .run();
  if (status === 'failed' && !stopped) opts.failures?.record('JOB_DISCOVERY_FAILED', `None of the ${failed} source(s) could be read (${firstError ?? 'no details'}).`);

  return { scanRunId, status, stats };
}

/** Marks scans and source runs left "running" by a crash as failed (called at worker start). */
export function failInterruptedScans(db: Db, now: Date = new Date()): number {
  const a = db.update(scanRuns).set({ status: 'failed', finishedAt: now, error: 'Interrupted (the worker stopped during the scan)' }).where(eq(scanRuns.status, 'running')).run().changes;
  db.update(sourceRuns).set({ status: 'failed', finishedAt: now, errorCode: 'SOURCE_UNAVAILABLE', error: 'Interrupted' }).where(eq(sourceRuns.status, 'running')).run();
  return a;
}
