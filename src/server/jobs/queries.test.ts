import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { matches, profiles, sources } from '../db/schema';
import { createIngestor } from './ingest';
import { getJob, jobCounts, listJobs } from './queries';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

function seed() {
  const src = t.db.insert(sources).values({ adapterId: 'remoteok', name: 'Remote OK', config: {}, origin: 'default', createdAt: clock }).returning().get().id;
  const ing = createIngestor({ db: t.db, now: () => clock });
  ing.ingestRun(src, [
    { sourceJobId: '1', sourceUrl: 'https://remoteok.com/1', title: 'React Developer', company: 'Acme', location: 'Remote', description: 'React and TypeScript', salaryText: '$100k - $120k' },
    { sourceJobId: '2', sourceUrl: 'https://remoteok.com/2', title: 'Staff Nurse', company: 'Clinic', description: 'Care' },
  ], { completeSnapshot: false });
  return { src, ing };
}

describe('job queries', () => {
  it('lists active jobs newest first with sources and state', () => {
    seed();
    const page = listJobs(t.db, { now: clock });
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ sources: ['Remote OK'], state: 'new' });
  });

  it('searches titles and companies', () => {
    seed();
    expect(listJobs(t.db, { q: 'nurse', now: clock }).items.map((j) => j.title)).toEqual(['Staff Nurse']);
    expect(listJobs(t.db, { q: 'acme', now: clock }).items.map((j) => j.title)).toEqual(['React Developer']);
  });

  it('treats % and _ in a search as plain characters, not wildcards', () => {
    seed();
    expect(listJobs(t.db, { q: '%', now: clock }).total).toBe(0);
    expect(listJobs(t.db, { q: 'Staff_Nurse', now: clock }).total).toBe(0);
    expect(listJobs(t.db, { q: 'Staff Nurse', now: clock }).total).toBe(1);
  });

  it('marks jobs updated after first discovery', () => {
    const { src, ing } = seed();
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    ing.ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://remoteok.com/1', title: 'React Developer', company: 'Acme', location: 'Remote', description: 'Now with Next.js too' }], { completeSnapshot: false });
    const item = listJobs(t.db, { now: clock }).items.find((j) => j.title === 'React Developer');
    expect(item?.state).toBe('updated');
  });

  it('paginates', () => {
    seed();
    const p = listJobs(t.db, { pageSize: 1, page: 2, now: clock });
    expect(p.items).toHaveLength(1);
    expect(p.total).toBe(2);
  });

  it('returns a job with all its listings and source attribution', () => {
    seed();
    const id = listJobs(t.db, { q: 'react', now: clock }).items[0].id;
    const job = getJob(t.db, id);
    expect(job?.listings[0]).toMatchObject({ sourceName: 'Remote OK', sourceUrl: 'https://remoteok.com/1', description: 'React and TypeScript' });
    expect(job?.matches).toEqual([]);
  });

  it('includes how the job matched each profile, so its page can link to the match', () => {
    seed();
    const id = listJobs(t.db, { q: 'react', now: clock }).items[0].id;
    const p = t.db.insert(profiles).values({ name: 'Frontend', isDefault: true, data: {}, preferences: {}, sliderValue: 100, createdAt: clock, updatedAt: clock }).returning().get();
    const m = t.db.insert(matches).values({ profileId: p.id, jobId: id, score: 88, decision: 'surfaced', method: 'heuristic', breakdown: {}, sliderValue: 100, jobVersion: 0, profileVersion: 0, reviewState: 'NEW', evaluatedAt: clock }).returning().get();
    expect(getJob(t.db, id)?.matches).toEqual([{ matchId: m.id, profileName: 'Frontend', score: 88, decision: 'surfaced', method: 'heuristic', filterReason: null }]);
  });

  it('counts jobs for the dashboard', () => {
    seed();
    expect(jobCounts(t.db, clock)).toEqual({ active: 2, newToday: 2 });
  });
});
