import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { jobListings, jobs, scanRuns, sourceRuns, sources as sourcesTable } from '../db/schema';
import { createHttpClient } from '../http';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createSettings } from '../settings';
import { registerBuiltInAdapters } from '../sources/adapters';
import { registerAdapter } from '../sources/registry';

registerBuiltInAdapters();
import { createSourceService } from '../sources/service';
import type { JobSourceAdapter, RawListing } from '../sources/types';
import { SourceError } from '../sources/types';
import { HttpError } from '../http';
import { createFailureLog } from '../failures';
import { runScan } from './scan';

const log = createLogger({ level: 'silent' });
const empty = z.object({}) as unknown as z.ZodType<Record<string, never>>;
const job = (id: string, title = 'Engineer'): RawListing => ({ sourceJobId: id, sourceUrl: `https://x.example/${id}`, title, company: 'Acme', description: `Job ${id} description text` });

function adapter(id: string, fetch: JobSourceAdapter<Record<string, never>>['fetch'], extra: Partial<JobSourceAdapter<Record<string, never>>> = {}) {
  const a: JobSourceAdapter<Record<string, never>> = { id, displayName: id, description: id, homepage: 'https://x.example', configFields: [], configSchema: empty, completeSnapshot: true, minIntervalMinutes: 1, fetch, ...extra };
  registerAdapter(a);
  return a;
}

adapter('t-ok', async function* () { yield job('1'); yield job('2', 'Designer'); });
adapter('t-ok2', async function* () { yield job('3', 'Analyst'); });
adapter('t-fail', async function* () { throw new SourceError('SOURCE_UNAVAILABLE', 'down for maintenance'); });
adapter('t-hang', (async function* ({ signal }) { await new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))); }) as JobSourceAdapter<Record<string, never>>['fetch']);
adapter('t-env', async function* () { yield job('9'); }, { requiresEnv: ['T_KEY'] });
let limitedCalls = 0;
adapter('t-limited', async function* () {
  limitedCalls++;
  throw SourceError.from(new HttpError('slow down', 429, 'https://x.example', 3_600_000));
});
adapter('t-default', async function* () {}, { defaultInstances: [{ name: 'Default one', config: {}, enabled: true }] });
adapter('t-bad', async function* () { yield job('5'); yield { sourceJobId: '6', sourceUrl: 'not a url', title: '', company: '', description: '' } as RawListing; });

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

function setup() {
  const settings = createSettings(t.db);
  const sources = createSourceService({ db: t.db, settings, now: () => clock });
  const ingestor = createIngestor({ db: t.db, now: () => clock });
  const changed: number[][] = [];
  const failures = createFailureLog(settings, () => clock);
  const scan = (trigger: 'schedule' | 'manual' = 'schedule') =>
    runScan({
      db: t.db, sources, ingestor, http: createHttpClient({ fetchImpl: fetch, minGapMs: 0 }), log, env: {}, ai: null, now: () => clock,
      hints: { titles: [], locations: [], keywords: [] }, trigger, signal: new AbortController().signal, sourceTimeoutMs: 100,
      onChangedJobs: (ids) => changed.push(ids),
      failures,
    });
  return { sources, scan, changed, failures };
}

describe('runScan', () => {
  it('ages out listings of a complete-snapshot board that has not worked for a month', async () => {
    const { sources, scan } = setup();
    const ok = sources.create('t-ok', 'Working board', {});
    await scan();
    const broken = sources.create('t-fail', 'Gone board', {});
    const ingestor = createIngestor({ db: t.db, now: () => clock });
    ingestor.ingestRun(broken.id, [job('old', 'Old role')], { completeSnapshot: true });
    t.db.update(sourcesTable).set({ lastSuccessAt: clock }).where(eq(sourcesTable.id, broken.id)).run();
    clock = new Date(clock.getTime() + 40 * 86_400_000);
    t.db.update(sourcesTable).set({ lastSuccessAt: clock }).where(eq(sourcesTable.id, ok.id)).run();
    await scan('manual');
    const status = (sourceId: number) => t.db.select({ s: jobListings.status }).from(jobListings).where(eq(jobListings.sourceId, sourceId)).all().map((r) => r.s);
    expect(status(broken.id)).toEqual(['expired']);
    expect(status(ok.id)).toEqual(['active', 'active']);
  });

  it('runs every enabled source, isolates failures and records stats', async () => {
    const { sources, scan, changed } = setup();
    sources.create('t-ok', 'OK source', {});
    sources.create('t-fail', 'Broken source', {});
    const summary = await scan();
    expect(summary.status).toBe('partial');
    expect(summary.stats).toMatchObject({ sources: 2, failed: 1, found: 2, newJobs: 2 });
    expect(changed[0]).toHaveLength(2);
    const runs = t.db.select().from(sourceRuns).all();
    expect(runs.map((r) => r.status).sort()).toEqual(['failed', 'success']);
    expect(runs.find((r) => r.status === 'failed')).toMatchObject({ errorCode: 'SOURCE_UNAVAILABLE', error: 'down for maintenance' });
    const failed = sources.list().find((s) => s.adapterId === 't-fail')!;
    expect(failed).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 1 });
    expect(t.db.select().from(scanRuns).get()).toMatchObject({ status: 'partial' });
  });

  it('never fetches a source more often than its minimum interval', async () => {
    const { sources, scan } = setup();
    sources.create('t-ok', 'OK', {});
    await scan();
    clock = new Date(clock.getTime() + 30_000);
    const second = await scan('manual');
    expect(second.stats).toMatchObject({ skipped: 1, found: 0 });
    // Nothing was due: the scan says so instead of a "success" that found nothing (final review, new-user #5).
    expect(second.status).toBe('skipped');
    expect(t.db.select().from(scanRuns).where(eq(scanRuns.id, second.scanRunId)).get()?.error).toMatch(/checked recently.*next one is due/i);
    clock = new Date(clock.getTime() + 60_000);
    const third = await scan();
    expect(third.stats).toMatchObject({ skipped: 0, found: 2, newJobs: 0 });
  });

  it('fails a hanging source after its timeout without blocking the scan', async () => {
    const { sources, scan } = setup();
    sources.create('t-hang', 'Hangs', {});
    sources.create('t-ok', 'OK', {});
    const summary = await scan();
    expect(summary.stats.failed).toBe(1);
    expect(t.db.select().from(sourceRuns).where(eq(sourceRuns.status, 'failed')).get()?.error).toMatch(/timed out/i);
    expect(t.db.select().from(jobs).all()).toHaveLength(2);
  });

  it('skips sources whose required keys are missing, with a clear reason', async () => {
    const { sources, scan } = setup();
    sources.create('t-env', 'Needs key', {});
    const summary = await scan();
    expect(summary.stats.skipped).toBe(1);
    expect(sources.list()[0].lastError).toMatch(/T_KEY/);
  });

  it('hands over changed jobs per source as soon as each source is stored', async () => {
    const { sources, scan, changed } = setup();
    sources.create('t-ok', 'OK', {});
    sources.create('t-ok2', 'Other', {});
    await scan();
    expect(changed.length).toBe(2);
  });

  it('marks the scan failed when every source fails', async () => {
    const { sources, scan } = setup();
    sources.create('t-fail', 'Broken', {});
    expect((await scan()).status).toBe('failed');
  });
});

describe('cancellation', () => {
  it('does not count sources skipped by a cancelled scan as failures', async () => {
    const { sources } = setup();
    sources.create('t-ok', 'OK', {});
    const ac = new AbortController();
    ac.abort();
    const { runScan: run } = await import('./scan');
    await run({
      db: t.db, sources, ingestor: createIngestor({ db: t.db, now: () => clock }), http: createHttpClient({ fetchImpl: fetch, minGapMs: 0 }), log, env: {}, ai: null, now: () => clock,
      hints: { titles: [], locations: [], keywords: [] }, trigger: 'manual', signal: ac.signal,
    });
    expect(sources.list()[0]).toMatchObject({ consecutiveFailures: 0, lastRunAt: null });
  });

  it('a scan stopped part-way is not a success, and the interrupted source still counts as asked (its rate limit holds, round 3)', async () => {
    const { sources } = setup();
    sources.create('t-ok', 'OK', {});
    const slow = sources.create('t-hang', 'Slow', {});
    const ac = new AbortController();
    const run = runScan({
      db: t.db, sources, ingestor: createIngestor({ db: t.db, now: () => clock }), http: createHttpClient({ fetchImpl: fetch, minGapMs: 0 }), log, env: {}, ai: null, now: () => clock,
      hints: { titles: [], locations: [], keywords: [] }, trigger: 'manual', signal: ac.signal, sourceTimeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const summary = await run;
    expect(summary.status).toBe('partial');
    expect(t.db.select().from(scanRuns).get()?.error).toMatch(/stopped before it finished/i);
    // The request had already gone out: asking again at once would break the source's limit (e.g. Remotive's 4 a day).
    expect(sources.list().find((s) => s.id === slow.id)).toMatchObject({ lastRunAt: clock, lastStatus: 'skipped', lastError: 'Stopped before it finished' });
  });
});

describe('rate limits', () => {
  it('waits as long as the source asked before trying again', async () => {
    const { sources, scan } = setup();
    sources.create('t-limited', 'Busy', {});
    await scan();
    expect(sources.list()[0]).toMatchObject({ lastStatus: 'failed' });
    expect(sources.list()[0].notBefore?.getTime()).toBe(clock.getTime() + 3_600_000);
    clock = new Date(clock.getTime() + 30 * 60_000);
    await scan();
    expect(limitedCalls).toBe(1);
    clock = new Date(clock.getTime() + 31 * 60_000);
    await scan();
    expect(limitedCalls).toBe(2);
  });
});

describe('failure alerts', () => {
  it('reports a source once when it has failed three times in a row', async () => {
    const { sources } = setup();
    sources.create('t-fail', 'Broken', {});
    const alerts: string[] = [];
    for (let i = 0; i < 4; i++) {
      await runScan({
        db: t.db, sources, ingestor: createIngestor({ db: t.db, now: () => clock }), http: createHttpClient({ fetchImpl: fetch, minGapMs: 0 }), log, env: {}, ai: null, now: () => clock,
        hints: { titles: [], locations: [], keywords: [] }, trigger: 'schedule', signal: new AbortController().signal,
        onSourceFailing: (s) => alerts.push(s.name),
      });
      clock = new Date(clock.getTime() + 120_000);
    }
    expect(alerts).toEqual(['Broken']);
  });
});

describe('discovered sources', () => {
  it('are disabled after repeated failures', async () => {
    const { sources, scan } = setup();
    sources.registerDiscovered('t-fail', 'Found', {});
    for (let i = 0; i < 3; i++) {
      await scan();
      clock = new Date(clock.getTime() + 120_000);
    }
    const s = sources.list()[0];
    expect(s.enabled).toBe(false);
    expect(s.lastError).toMatch(/disabled/i);
  });
});

describe('source service', () => {
  it('seeds default sources once and never re-creates one the user deleted', () => {
    const { sources } = setup();
    sources.ensureDefaults();
    sources.ensureDefaults();
    const seeded = sources.list().filter((s) => s.adapterId === 't-default');
    expect(seeded).toHaveLength(1);
    sources.remove(seeded[0].id);
    sources.ensureDefaults();
    expect(sources.list().filter((s) => s.adapterId === 't-default')).toHaveLength(0);
  });

  it('validates configuration against the adapter and rejects unknown adapters', () => {
    const { sources } = setup();
    expect(() => sources.create('nope', 'x', {})).toThrow(/Unknown source type/);
    // Problems are named by the form's label, not the setting's internal key.
    expect(() => sources.create('greenhouse', 'x', { board: 'not a valid board!' })).toThrow(/^Board name: Use the short name/);
  });

  it('registers discovered boards once', () => {
    const { sources } = setup();
    sources.registerDiscovered('t-ok', 'Found board', {});
    sources.registerDiscovered('t-ok', 'Found board', {});
    expect(sources.list().filter((s) => s.origin === 'discovered')).toHaveLength(1);
  });

  it('recognises a board already configured under different capitalisation or extra settings', () => {
    const { sources } = setup();
    sources.create('lever', 'Palantir', { company: 'Palantir', companyName: 'Palantir Technologies' });
    expect(sources.registerDiscovered('lever', 'palantir', { company: 'palantir' })).toBeNull();
  });

  it('never re-adds a board the user deleted', () => {
    const { sources } = setup();
    const s = sources.registerDiscovered('greenhouse', 'acme', { board: 'acme' })!;
    sources.remove(s.id);
    expect(sources.registerDiscovered('greenhouse', 'acme', { board: 'ACME' })).toBeNull();
  });

  it('records JOB_DISCOVERY_FAILED when no source could be read, and JOB_PARSE_FAILED for unreadable listings (PRD §51)', async () => {
    const { sources, scan, failures } = setup();
    const broken = sources.create('t-fail', 'Broken source', {});
    expect((await scan()).status).toBe('failed');
    expect(failures.recent()[0]).toMatchObject({ code: 'JOB_DISCOVERY_FAILED', message: expect.stringMatching(/down for maintenance/) });
    sources.update(broken.id, { enabled: false });
    sources.create('t-bad', 'Messy board', {});
    expect((await scan('manual')).status).toBe('success');
    expect(failures.recent()[0]).toMatchObject({ code: 'JOB_PARSE_FAILED', context: 'Messy board', message: expect.stringMatching(/1 listing/) });
  });
});
