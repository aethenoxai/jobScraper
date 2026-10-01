import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { jobListings, jobs, sources } from '../db/schema';
import type { RawListing } from '../sources/types';
import { createIngestor } from './ingest';
import { fingerprint, normalizeCompany } from './normalize';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
const DAY = 86_400_000;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

const addSource = (adapterId: string) =>
  t.db.insert(sources).values({ adapterId, name: adapterId, config: {}, origin: 'user', createdAt: clock }).returning().get().id;

const listing = (id: string, over: Partial<RawListing> = {}): RawListing => ({
  sourceJobId: id,
  sourceUrl: `https://jobs.example/${id}`,
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Bengaluru, India',
  description: `Build payment APIs in Go for job ${id}. You will design services, write tests and own reliability.`,
  ...over,
});

const make = () => createIngestor({ db: t.db, now: () => clock });

describe('ingest', () => {
  it('creates jobs for new listings and reports nothing new when nothing changed (PRD §12.1)', () => {
    const src = addSource('greenhouse');
    const ing = make();
    const first = ing.ingestRun(src, [listing('1'), listing('2', { title: 'Frontend Engineer' })], { completeSnapshot: true });
    expect(first.stats).toMatchObject({ found: 2, newListings: 2, newJobs: 2, updated: 0, unchanged: 0 });
    expect(first.changedJobIds).toHaveLength(2);

    clock = new Date(clock.getTime() + 30 * 60_000);
    const second = ing.ingestRun(src, [listing('1'), listing('2', { title: 'Frontend Engineer' })], { completeSnapshot: true });
    expect(second.stats).toMatchObject({ found: 2, newListings: 0, newJobs: 0, updated: 0, unchanged: 2 });
    expect(second.changedJobIds).toEqual([]);
  });

  it('reports a changed description as an update of the same job', () => {
    const src = addSource('greenhouse');
    const ing = make();
    const first = ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    const again = ing.ingestRun(src, [listing('1', { description: 'Completely rewritten description: now we need a Rust engineer for our ledger.' })], { completeSnapshot: true });
    expect(again.stats).toMatchObject({ updated: 1, newJobs: 0 });
    expect(again.changedJobIds).toEqual(first.changedJobIds);
  });

  it('a renamed posting updates its job’s identity, so other sources find it under the new title (M2 deferred minor)', () => {
    const src = addSource('greenhouse');
    const ing = make();
    const [jobId] = ing.ingestRun(src, [listing('1', { company: 'Acme Inc.' })], { completeSnapshot: true }).changedJobIds;
    ing.ingestRun(src, [listing('1', { company: 'Acme Inc.', title: 'Platform Engineer, Payments' })], { completeSnapshot: true });
    expect(t.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({ title: 'Platform Engineer, Payments', fingerprint: fingerprint('Acme Inc.', 'Platform Engineer, Payments'), companyKey: normalizeCompany('Acme Inc.') });
  });

  it('repairs text a feed sent doubly encoded, in every field', () => {
    const src = addSource('remoteok');
    const [jobId] = make().ingestRun(src, [listing('m1', { title: 'Mec\u00c3\u00a1nico Automotriz', company: 'Taller Jos\u00c3\u00a9', description: 'You\u00e2\u0080\u0099ll fix cars \u00e2\u0080\u0094 and more.' })], { completeSnapshot: false }).changedJobIds;
    expect(t.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({ title: 'Mec\u00e1nico Automotriz', company: 'Taller Jos\u00e9' });
    expect(t.db.select().from(jobListings).where(eq(jobListings.jobId, jobId)).get()?.description).toBe('You\u2019ll fix cars \u2014 and more.');
  });

  it('a listing past its own expiry date stays expired while the feed still lists it, without re-matching each scan (final review I2)', () => {
    const src = addSource('himalayas');
    const ing = make();
    const past = new Date(clock.getTime() - DAY);
    const [jobId] = ing.ingestRun(src, [listing('h1', { expiresAt: past })], { completeSnapshot: false }).changedJobIds ?? [];
    ing.expireStale();
    clock = new Date(clock.getTime() + 60 * 60_000);
    const again = ing.ingestRun(src, [listing('h1', { expiresAt: past })], { completeSnapshot: false });
    expect(again.changedJobIds).toEqual([]);
    const id = jobId ?? t.db.select().from(jobs).get()!.id;
    expect(t.db.select().from(jobs).where(eq(jobs.id, id)).get()?.status).toBe('expired');
  });

  it('a job the user added keeps showing even if its page carries an old expiry date', () => {
    const manual = addSource('manual');
    const ing = make();
    ing.ingestRun(manual, [listing('pasted-1', { expiresAt: new Date(clock.getTime() - 30 * DAY) })], { completeSnapshot: false });
    ing.expireStale();
    expect(t.db.select().from(jobs).get()?.status).toBe('active');
  });

  it('links the same job found on two sources to one canonical job without re-announcing it', () => {
    const gh = addSource('greenhouse');
    const agg = addSource('remotive');
    const ing = make();
    const a = ing.ingestRun(gh, [listing('gh-1', { company: 'Acme Inc.' })], { completeSnapshot: true });
    const b = ing.ingestRun(agg, [listing('rm-9', { title: 'Backend Engineer', company: 'ACME', location: 'Remote, Bengaluru' })], { completeSnapshot: false });
    expect(b.stats).toMatchObject({ newListings: 1, newJobs: 0 });
    expect(b.changedJobIds).toEqual([]);
    expect(t.db.select().from(jobs).all()).toHaveLength(1);
    expect(t.db.select().from(jobListings).where(eq(jobListings.jobId, a.changedJobIds[0])).all()).toHaveLength(2);
  });

  it('keeps same-titled roles in clearly different cities apart', () => {
    const src = addSource('greenhouse');
    make().ingestRun(src, [listing('ny', { location: 'New York, NY' }), listing('ldn', { location: 'London, UK' })], { completeSnapshot: true });
    expect(t.db.select().from(jobs).all()).toHaveLength(2);
  });

  it('matches near-duplicate postings with slightly different titles (fuzzy)', () => {
    const a = addSource('greenhouse');
    const b = addSource('arbeitnow');
    const desc = 'We are looking for an engineer to build and operate our payments platform. You will own APIs, write Go services, take part in on-call, review designs and mentor teammates across three product squads.';
    const ing = make();
    ing.ingestRun(a, [listing('1', { title: 'Backend Engineer - Payments', description: desc })], { completeSnapshot: true });
    const r = ing.ingestRun(b, [listing('x', { title: 'Backend Engineer, Payments Team', description: `${desc} Apply today.` })], { completeSnapshot: false });
    expect(r.stats.newJobs).toBe(0);
  });

  it('expires listings missing from 3 successful complete runs, and revives them if they return', () => {
    const src = addSource('greenhouse');
    const ing = make();
    ing.ingestRun(src, [listing('1'), listing('2', { title: 'Frontend Engineer' })], { completeSnapshot: true });
    ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    const third = ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    expect(third.stats.expired).toBe(1);
    const job2 = t.db.select().from(jobs).where(eq(jobs.title, 'Frontend Engineer')).get();
    expect(job2?.status).toBe('expired');
    ing.ingestRun(src, [listing('1'), listing('2', { title: 'Frontend Engineer' })], { completeSnapshot: true });
    expect(t.db.select().from(jobs).where(eq(jobs.title, 'Frontend Engineer')).get()?.status).toBe('active');
  });

  it('does not expire by absence for partial sources, but does by age and expiry date', () => {
    const src = addSource('himalayas');
    const ing = make();
    ing.ingestRun(src, [listing('1'), listing('2', { title: 'Frontend Engineer', expiresAt: new Date(clock.getTime() + DAY) })], { completeSnapshot: false });
    for (let i = 0; i < 3; i++) ing.ingestRun(src, [], { completeSnapshot: false });
    expect(t.db.select().from(jobListings).where(eq(jobListings.status, 'expired')).all()).toHaveLength(0);
    clock = new Date(clock.getTime() + 2 * DAY);
    expect(ing.expireStale()).toBe(1);
    clock = new Date(clock.getTime() + 31 * DAY);
    expect(ing.expireStale()).toBe(1);
    expect(t.db.select().from(jobs).where(eq(jobs.status, 'active')).all()).toHaveLength(0);
  });

  it('counts invalid listings as parse errors and still ingests the rest', () => {
    const src = addSource('greenhouse');
    const r = make().ingestRun(src, [listing('1'), { ...listing('2'), sourceUrl: 'not-a-url' }, { ...listing('3'), title: '' }], { completeSnapshot: true });
    expect(r.stats).toMatchObject({ found: 3, parseErrors: 2, newJobs: 1 });
  });

  it('keeps the stored description when a known listing arrives without one', () => {
    const src = addSource('smartrecruiters');
    const ing = make();
    ing.ingestRun(src, [listing('1')], { completeSnapshot: false });
    const r = ing.ingestRun(src, [listing('1', { description: null })], { completeSnapshot: false });
    expect(r.stats.unchanged).toBe(1);
    expect(t.db.select().from(jobListings).get()?.description).toMatch(/Build payment APIs/);
    expect(ing.knownIds(src)).toEqual(new Set(['1']));
  });

  it('never merges two postings from the same source', () => {
    const src = addSource('greenhouse');
    const r = make().ingestRun(src, [listing('1', { title: 'Account Executive', location: 'Remote' }), listing('2', { title: 'Account Executive', location: 'Remote' })], { completeSnapshot: true });
    expect(r.stats.newJobs).toBe(2);
  });

  it('merges a source’s exact repeats when it mirrors postings across its sites (Arbeitnow .fr/.ch)', () => {
    const src = addSource('arbeitnow');
    const description = 'Keep our network running around the clock: monitor links, handle incidents with the on-call team, and automate routine checks with Python and Ansible.';
    const same = { title: 'Network Operation Engineer', company: 'Share', location: 'Berlin', description };
    const r = make().ingestRun(src, [listing('noe-fr', same), listing('noe-ch', same), listing('noe-munich', { ...same, location: 'Munich' })], { completeSnapshot: false, mergeRepeats: true });
    expect(r.stats).toMatchObject({ newJobs: 2, newListings: 3 });
  });

  it('a listing whose text was pruned is fetched in full again, and a touch never revives a posting past its expiry (round 2)', () => {
    const src = addSource('greenhouse');
    const ing = make();
    ing.ingestRun(src, [listing('old'), listing('exp', { expiresAt: new Date(clock.getTime() - DAY) })], { completeSnapshot: false });
    t.db.update(jobListings).set({ description: '', descriptionHash: sql`'pruned:' || ${jobListings.id}`, status: 'expired' }).where(eq(jobListings.sourceJobId, 'old')).run();
    expect([...ing.knownIds(src)]).toEqual(['exp']);
    ing.ingestRun(src, [{ ...listing('exp'), touchOnly: true }], { completeSnapshot: false });
    expect(t.db.select().from(jobListings).where(eq(jobListings.sourceJobId, 'exp')).get()?.status).toBe('expired');
  });

  it('keeps different seniority levels apart in fuzzy matching', () => {
    const a = addSource('greenhouse');
    const b = addSource('arbeitnow');
    const desc = 'Our data platform team builds pipelines in Spark and Airflow for analytics across the company. You will own ingestion and quality.';
    const ing = make();
    ing.ingestRun(a, [listing('1', { title: 'Data Engineer', description: desc })], { completeSnapshot: true });
    expect(ing.ingestRun(b, [listing('x', { title: 'Senior Data Engineer', description: desc })], { completeSnapshot: false }).stats.newJobs).toBe(1);
    expect(ing.ingestRun(b, [listing('y', { title: 'Software Engineer III', description: desc })], { completeSnapshot: false }).stats.newJobs).toBe(1);
  });

  it('does not merge jobs without descriptions or with a placeholder company', () => {
    const a = addSource('greenhouse');
    const b = addSource('adzuna');
    const ing = make();
    ing.ingestRun(a, [listing('1', { title: 'Account Manager', description: '' })], { completeSnapshot: true });
    expect(ing.ingestRun(b, [listing('x', { title: 'Senior Account Manager', description: '' })], { completeSnapshot: false }).stats.newJobs).toBe(1);
    ing.ingestRun(b, [listing('u1', { title: 'Driver', company: 'Unknown company', location: null })], { completeSnapshot: false });
    expect(ing.ingestRun(a, [listing('u2', { title: 'Driver', company: 'Unknown company', location: null })], { completeSnapshot: true }).stats.newJobs).toBe(1);
  });

  it('treats a re-posting long after the old job expired as a new job', () => {
    const a = addSource('greenhouse');
    const b = addSource('remotive');
    const ing = make();
    ing.ingestRun(a, [listing('old')], { completeSnapshot: true });
    for (let i = 0; i < 3; i++) ing.ingestRun(a, [], { completeSnapshot: true });
    clock = new Date(clock.getTime() + 200 * DAY);
    const r = ing.ingestRun(b, [listing('new')], { completeSnapshot: false });
    expect(r.stats.newJobs).toBe(1);
    expect(r.changedJobIds).toHaveLength(1);
  });

  it('reports a job revived by a new listing so it is matched again', () => {
    const a = addSource('greenhouse');
    const b = addSource('remotive');
    const ing = make();
    ing.ingestRun(a, [listing('1')], { completeSnapshot: true });
    for (let i = 0; i < 3; i++) ing.ingestRun(a, [], { completeSnapshot: true });
    const r = ing.ingestRun(b, [listing('again', { location: 'Bengaluru' })], { completeSnapshot: false });
    expect(r.stats).toMatchObject({ newJobs: 0, newListings: 1 });
    expect(r.changedJobIds).toHaveLength(1);
  });

  it('reports a listing seen again after it expired, as a change, so it is matched again', () => {
    const src = addSource('greenhouse');
    const ing = make();
    ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    for (let i = 0; i < 3; i++) ing.ingestRun(src, [], { completeSnapshot: true });
    const before = t.db.select().from(jobs).get()!;
    expect(before.status).toBe('expired');
    clock = new Date(clock.getTime() + DAY);
    const r = ing.ingestRun(src, [listing('1')], { completeSnapshot: true });
    expect(r.changedJobIds).toEqual([before.id]);
    const after = t.db.select().from(jobs).get()!;
    expect(after.status).toBe('active');
    expect(after.lastChangedAt.getTime()).toBeGreaterThan(before.lastChangedAt.getTime());
  });

  it('updates salary, work mode and type on known listings', () => {
    const src = addSource('greenhouse');
    const ing = make();
    ing.ingestRun(src, [listing('1', { salaryText: 'USD 100000 - 120000' })], { completeSnapshot: true });
    const r = ing.ingestRun(src, [listing('1', { salaryText: 'USD 150000 - 180000', workMode: 'remote' })], { completeSnapshot: true });
    expect(r.stats.updated).toBe(1);
    expect(t.db.select().from(jobs).get()).toMatchObject({ salaryMin: 150000, workMode: 'remote' });
  });

  it('touch-only listings refresh a known job without changing it', () => {
    const src = addSource('web');
    const ing = make();
    ing.ingestRun(src, [listing('page')], { completeSnapshot: false });
    const r = ing.ingestRun(src, [{ ...listing('page', { title: 'Re-extracted title', description: 'different page text' }), touchOnly: true }], { completeSnapshot: false });
    expect(r.stats).toMatchObject({ unchanged: 1, updated: 0 });
    expect(t.db.select().from(jobListings).get()?.title).toBe('Backend Engineer');
  });

  it('never expires jobs the user added, and leaves complete sources to their own expiry rule', () => {
    const manual = t.db.insert(sources).values({ adapterId: 'manual', name: 'Added by you', config: {}, origin: 'default', enabled: false, createdAt: clock }).returning().get().id;
    const board = addSource('greenhouse');
    const ing = make();
    ing.ingestRun(manual, [listing('mine')], { completeSnapshot: false });
    ing.ingestRun(board, [listing('b', { title: 'Designer' })], { completeSnapshot: true });
    clock = new Date(clock.getTime() + 40 * DAY);
    expect(ing.expireStale(new Set([board]))).toBe(0);
  });
});
