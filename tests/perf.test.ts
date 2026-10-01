/**
 * Performance budget (PLAN M9 Task 4): with a year's worth of jobs (10k jobs and listings, two profiles) the feed,
 * the jobs list and the dashboard numbers answer in under 300 ms, and ingesting 1,000 new listings takes under 2 s.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplicationService } from '@/server/applications/service';
import { jobListings, jobs, matches, sources } from '@/server/db/schema';
import { createIngestor } from '@/server/jobs/ingest';
import { jobCounts, listJobs } from '@/server/jobs/queries';
import { createLogger } from '@/server/logging';
import { createMatchService } from '@/server/matching/service';
import { createProfileService } from '@/server/profile/service';
import { createQueue } from '@/server/queue';
import { createFileStore } from '@/server/storage';
import { createTempDb } from './helpers/temp-db';

const JOBS = 10_000;
const BUDGET_MS = 300;
const TITLES = ['Backend Engineer', 'Data Analyst', 'QA Engineer', 'Product Designer', 'DevOps Engineer', 'Sales Manager', 'Staff Nurse', 'Accountant'];
const MODES = ['remote', 'hybrid', 'onsite'] as const;

let t: ReturnType<typeof createTempDb>;
let matching: ReturnType<typeof createMatchService>;
let profileIds: number[] = [];
let sourceId = 0;

/** Median of a few runs, so one slow tick of the machine doesn't decide. */
function timed(fn: () => unknown, runs = 5): number {
  fn(); // warm the statement cache
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

beforeAll(() => {
  t = createTempDb();
  const files = createFileStore(path.join(t.dir, 'files'));
  const queue = createQueue(t.db);
  const profiles = createProfileService({ db: t.db, files });
  matching = createMatchService({ db: t.db, ai: null, queue, profiles, log: createLogger({ level: 'silent' }) });
  createApplicationService({ db: t.db, files, queue, profiles });
  profileIds = [profiles.create('Engineer').id, profiles.create('Analyst').id];
  sourceId = t.db.insert(sources).values({ adapterId: 'manual', name: 'Bulk', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const year = 365 * 86_400_000;
  const now = Date.now();
  t.db.transaction((tx) => {
    for (let i = 0; i < JOBS; i++) {
      const title = TITLES[i % TITLES.length];
      const company = `Company ${i % 900}`;
      const seen = new Date(now - Math.floor((i / JOBS) * year));
      const job = tx
        .insert(jobs)
        .values({ fingerprint: `fp-${i}`, companyKey: company.toLowerCase(), title, company, location: i % 3 ? 'Pune, India' : 'Remote', workMode: MODES[i % 3], status: i % 10 === 0 ? 'expired' : 'active', firstSeenAt: seen, lastSeenAt: seen, lastChangedAt: seen })
        .returning({ id: jobs.id })
        .get();
      const description = `${title} at ${company}. Requirements: Go, SQL, communication. Job ${i}.`;
      tx.insert(jobListings).values({ jobId: job.id, sourceId, sourceJobId: `bulk-${i}`, sourceUrl: `https://jobs.example.test/${i}`, title, company, location: 'Pune, India', description, descriptionHash: createHash('sha256').update(description).digest('hex'), status: 'active', firstSeenAt: seen, lastSeenAt: seen, lastChangedAt: seen }).run();
      for (const [n, profileId] of profileIds.entries()) {
        const score = (i * 7 + n * 13) % 101;
        tx.insert(matches).values({ profileId, jobId: job.id, score, breakdown: {}, decision: score >= 40 ? 'surfaced' : 'filtered', filterReason: score >= 40 ? null : 'score', reviewState: (['NEW', 'VIEWED', 'APPROVED', 'SKIPPED'] as const)[i % 4], method: 'heuristic', sliderValue: 70, jobVersion: seen.getTime(), profileVersion: 1, firstSurfacedAt: score >= 40 ? seen : null, evaluatedAt: seen }).run();
      }
    }
  });
}, 120_000);
afterAll(() => t?.cleanup());

describe(`performance with ${JOBS.toLocaleString('en')} jobs and two profiles`, () => {
  it.each([
    ['the default feed (by score)', {}],
    ['the feed sorted by date', { sort: 'date' as const }],
    ['a deep feed page', { page: 50 }],
    ['the feed searched by title or company', { q: 'Engineer' }],
    ['jobs waiting for review', { state: 'pending' as const }],
    ['jobs from one source, found this week', { sourceId: -1, foundWithinDays: 7 }],
    ['filtered-out jobs', { view: 'filtered' as const }],
  ])(`%s answers in under ${BUDGET_MS} ms`, (_name, opts) => {
    const o = 'sourceId' in opts ? { ...opts, sourceId } : opts;
    const ms = timed(() => matching.feed(profileIds[0], o));
    expect(matching.feed(profileIds[0], o).items.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it(`the dashboard numbers and the jobs list answer in under ${BUDGET_MS} ms`, () => {
    expect(timed(() => matching.counts(profileIds[0]))).toBeLessThan(BUDGET_MS);
    expect(timed(() => matching.counts())).toBeLessThan(BUDGET_MS);
    expect(timed(() => jobCounts(t.db))).toBeLessThan(BUDGET_MS);
    expect(timed(() => listJobs(t.db, { q: 'Pune', page: 20 }))).toBeLessThan(BUDGET_MS);
  });

  it('ingests 1,000 new listings in under 2 s', () => {
    const src = t.db.insert(sources).values({ adapterId: 'manual', name: 'New', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
    const listings = Array.from({ length: 1000 }, (_, i) => ({ sourceJobId: `new-${i}`, sourceUrl: `https://new.example.test/${i}`, title: TITLES[i % TITLES.length], company: `Newco ${i}`, location: 'Pune, India', description: `Requirements\n• Go\n• SQL\nRole ${i}` }));
    const start = performance.now();
    const r = createIngestor({ db: t.db }).ingestRun(src, listings, { completeSnapshot: true });
    const ms = performance.now() - start;
    expect(r.changedJobIds).toHaveLength(1000);
    expect(ms).toBeLessThan(2000);
  }, 30_000);
});
