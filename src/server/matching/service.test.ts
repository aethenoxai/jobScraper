import { eq } from 'drizzle-orm';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { applicationEvents, applications, jobAnalyses, jobListings, jobs, matches, sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createFileStore } from '../storage';
import { createMatchService, JobClosedError, PREPARE_TASK } from './service';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

const JD = `Requirements
• 3+ years of experience
• Strong Go skills
• PostgreSQL
Nice to have
• Kubernetes`;

function setup() {
  const now = () => clock;
  const profiles = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'f')), now });
  const queue = createQueue(t.db, { now });
  const svc = createMatchService({ db: t.db, ai: null, queue, profiles, log: createLogger({ level: 'silent' }), now });
  const ing = createIngestor({ db: t.db, now });
  const gh = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme careers', config: {}, origin: 'user', createdAt: clock }).returning().get().id;
  const agg = t.db.insert(sources).values({ adapterId: 'remotive', name: 'Remotive', config: {}, origin: 'default', createdAt: clock }).returning().get().id;
  const p = profiles.create('Engineer');
  const data = emptyProfile();
  data.headline = 'Backend Engineer';
  data.yearsExperience = 5;
  data.skills = ['Go', 'PostgreSQL'].map((name) => ({ id: '', name, category: 'technology' as const }));
  profiles.updateData(p.id, data, { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, locations: ['Bangalore'], targetTitles: ['Backend Engineer'] }, 100);
  const add = (src: number, id: string, over: Record<string, unknown> = {}) =>
    ing.ingestRun(src, [{ sourceJobId: id, sourceUrl: `https://x.example/${id}`, title: 'Backend Engineer', company: 'Acme', location: 'Bangalore, India', workMode: 'hybrid', employmentType: 'full-time', description: JD, ...over }], { completeSnapshot: false }).changedJobIds[0];
  return { svc, profiles, queue, ing, gh, agg, add, profileId: p.id };
}

describe('match service', () => {
  it('keeps jobs far above the user’s level below the usual thresholds', async () => {
    const { svc, add, profileId } = setup();
    const vp = await svc.evaluate(add(1, 'vp', { title: 'VP Backend Engineer' }), profileId);
    expect(vp.score).toBeLessThanOrEqual(65);
    const stored = t.db.select().from(matches).where(eq(matches.id, vp.matchId)).get()!;
    expect(JSON.stringify(stored.breakdown)).toMatch(/levels above/);
  });

  it('surfaces a fitting job with a breakdown and filters one that fails a gate', async () => {
    const { svc, add, profileId } = setup();
    const good = add(1, 'good');
    const far = add(1, 'far', { title: 'Registered Nurse', company: 'Clinic', description: 'Patient care' });
    const a = await svc.evaluate(good, profileId);
    const b = await svc.evaluate(far, profileId);
    expect(a).toMatchObject({ decision: 'surfaced', newlySurfaced: true });
    expect(a.score).toBeGreaterThanOrEqual(76);
    expect(b).toMatchObject({ decision: 'filtered', newlySurfaced: false });
    const stored = t.db.select().from(matches).where(eq(matches.jobId, far)).get();
    expect(stored?.filterReason).toMatch(/target roles/);
  });

  it('skips unchanged jobs and re-evaluates changed ones, keeping the review state', async () => {
    const { svc, add, profileId, ing } = setup();
    const job = add(1, 'j');
    await svc.evaluate(job, profileId);
    expect((await svc.evaluate(job, profileId)).skipped).toBe(true);
    const match = t.db.select().from(matches).get()!;
    svc.view(match.id);
    clock = new Date(clock.getTime() + 60_000);
    ing.ingestRun(1, [{ sourceJobId: 'j', sourceUrl: 'https://x.example/j', title: 'Backend Engineer', company: 'Acme', location: 'Bangalore, India', workMode: 'hybrid', employmentType: 'full-time', description: `${JD}\n• Redis` }], { completeSnapshot: false });
    const again = await svc.evaluate(job, profileId);
    expect(again.skipped).toBeFalsy();
    expect(again.newlySurfaced).toBe(false);
    expect(t.db.select().from(matches).get()?.reviewState).toBe('VIEWED');
  });

  it('approving creates one application per listing, records events and queues preparation (N1, N11)', async () => {
    const { svc, add, profileId, queue } = setup();
    const job = add(1, 'gh-1');
    add(2, 'rm-1');
    await svc.evaluate(job, profileId);
    const match = t.db.select().from(matches).get()!;
    const app = svc.approve(match.id);
    expect(app).toMatchObject({ status: 'PREPARING', method: 'browser' });
    expect(svc.approve(match.id).id).toBe(app.id);
    const listings = svc.listingsFor(job);
    const other = listings.find((l) => l.id !== app.listingId)!;
    const second = svc.approve(match.id, other.id);
    expect(second.id).not.toBe(app.id);
    expect(t.db.select().from(applications).all()).toHaveLength(2);
    expect(t.db.select().from(matches).get()?.reviewState).toBe('APPROVED');
    expect(t.db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, app.id)).all().map((e) => e.type)).toContain('approved');
    expect(queue.claim('w', [PREPARE_TASK])?.payload).toEqual({ applicationId: app.id });
  });

  it('prefers the company’s own listing when approving', async () => {
    const { svc, add, profileId } = setup();
    const job = add(2, 'agg-first');
    add(1, 'ats-second');
    await svc.evaluate(job, profileId);
    const app = svc.approve(t.db.select().from(matches).get()!.id);
    expect(svc.listingsFor(job).find((l) => l.id === app.listingId)?.sourceName).toBe('Acme careers');
  });

  it('skip and undo', async () => {
    const { svc, add, profileId } = setup();
    await svc.evaluate(add(1, 'x'), profileId);
    const id = t.db.select().from(matches).get()!.id;
    svc.skip(id);
    expect(t.db.select().from(matches).get()?.reviewState).toBe('SKIPPED');
    svc.undoSkip(id);
    expect(t.db.select().from(matches).get()?.reviewState).toBe('VIEWED');
  });

  it('a slider-only change is applied from the stored score without re-evaluating', async () => {
    const { svc, add, profileId, profiles } = setup();
    const job = add(1, 'x');
    await svc.evaluate(job, profileId);
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 200);
    const r = await svc.evaluate(job, profileId);
    expect(r.skipped).toBe(true);
    expect(t.db.select().from(matches).get()).toMatchObject({ sliderValue: 200, decision: r.score >= 95 ? 'surfaced' : 'filtered' });
  });

  it('re-decides from stored scores when only the slider changes', async () => {
    const { svc, add, profileId, profiles } = setup();
    const r = await svc.evaluate(add(1, 'x'), profileId);
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 200);
    const changed = svc.redecide(profileId);
    expect(t.db.select().from(matches).get()?.decision).toBe(r.score >= 95 ? 'surfaced' : 'filtered');
    expect(changed.newlySurfaced).toEqual([]);
  });

  it('filters the feed by source, when the job was found, and new or updated', async () => {
    const { svc, add, profileId, gh, agg } = setup();
    await svc.evaluate(add(gh, 'old', { company: 'OldCo' }), profileId);
    clock = new Date(clock.getTime() + 10 * 86_400_000);
    await svc.evaluate(add(agg, 'new', { company: 'NewCo' }), profileId);
    const companies = (o: Parameters<typeof svc.feed>[1]) => svc.feed(profileId, o).items.map((i) => i.company);
    expect(companies({ sourceId: agg })).toEqual(['NewCo']);
    expect(companies({ foundWithinDays: 7 })).toEqual(['NewCo']);
    expect(companies({ fresh: 'new' })).toEqual(['NewCo']);
    expect(companies({ fresh: 'updated' })).toEqual([]);
    const oldJob = add(gh, 'old', { company: 'OldCo', description: `${JD}\nNow with a pension.` });
    await svc.evaluate(oldJob, profileId);
    expect(companies({ fresh: 'updated' })).toEqual(['OldCo']);
  });

  it('counts submitted applications, including ones later rejected or withdrawn', async () => {
    const { svc, add, profileId } = setup();
    const m = await svc.evaluate(add(1, 'a'), profileId);
    svc.approve(m.matchId);
    t.db.update(applications).set({ status: 'REJECTED', submittedAt: clock }).run();
    expect(svc.counts(profileId, clock)).toMatchObject({ submitted: 1, rejected: 1 });
  });

  it('refuses to approve a job that is no longer listed, unless it was already approved', async () => {
    const { svc, add, profileId } = setup();
    const open = await svc.evaluate(add(1, 'open'), profileId);
    const app = svc.approve(open.matchId);
    const closed = await svc.evaluate(add(1, 'closed', { company: 'Gone Co' }), profileId);
    for (const id of [open.matchId, closed.matchId]) {
      const jobId = t.db.select().from(matches).where(eq(matches.id, id)).get()!.jobId;
      t.db.update(jobs).set({ status: 'expired' }).where(eq(jobs.id, jobId)).run();
      t.db.update(jobListings).set({ status: 'expired' }).where(eq(jobListings.jobId, jobId)).run();
    }
    expect(() => svc.approve(closed.matchId)).toThrow(JobClosedError);
    expect(svc.approve(open.matchId).id).toBe(app.id);
  });

  it('skip says whether it changed anything', async () => {
    const { svc, add, profileId } = setup();
    const a = await svc.evaluate(add(1, 'a'), profileId);
    const b = await svc.evaluate(add(1, 'b', { company: 'B Co' }), profileId);
    svc.approve(b.matchId);
    expect(svc.skip(a.matchId)).toBe(true);
    expect(svc.skip(a.matchId)).toBe(false);
    expect(svc.skip(b.matchId)).toBe(false);
    expect(svc.skip(999_999)).toBe(false);
  });

  it('builds the feed and dashboard counts', async () => {
    const { svc, add, profileId } = setup();
    await svc.evaluate(add(1, 'a'), profileId);
    await svc.evaluate(add(1, 'b', { title: 'Nurse', company: 'Clinic', description: 'care' }), profileId);
    const feed = svc.feed(profileId, {});
    expect(feed.items.map((i) => i.title)).toEqual(['Backend Engineer']);
    expect(feed.items[0]).toMatchObject({ reviewState: 'NEW', sources: ['Acme careers'] });
    expect(svc.feed(profileId, { view: 'filtered' }).items.map((i) => i.title)).toEqual(['Nurse']);
    expect(svc.counts(profileId, clock)).toMatchObject({ matching: 1, awaitingApproval: 1, newMatches: 1 });
  });

  it('only the first surfacing of a job counts as new (no repeat alerts after review or slider changes)', async () => {
    const { svc, add, profileId, profiles } = setup();
    const job = add(1, 'x');
    expect((await svc.evaluate(job, profileId)).newlySurfaced).toBe(true);
    const id = t.db.select().from(matches).get()!.id;
    svc.skip(id);
    t.db.update(matches).set({ score: 80 }).run();
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 200);
    svc.redecide(profileId);
    expect(t.db.select().from(matches).get()?.decision).toBe('filtered');
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 70);
    expect(svc.redecide(profileId).newlySurfaced).toEqual([]);
  });

  it('approving again never re-queues preparation', async () => {
    const { svc, add, profileId, queue } = setup();
    await svc.evaluate(add(1, 'gh-1'), profileId);
    const match = t.db.select().from(matches).get()!;
    svc.approve(match.id);
    const task = queue.claim('w', [PREPARE_TASK])!;
    queue.complete(task.id);
    t.db.update(applications).set({ status: 'READY' }).run();
    svc.approve(match.id);
    expect(queue.claim('w', [PREPARE_TASK])).toBeNull();
  });

  it('a job paying below the minimum salary is held back with a reason', async () => {
    const { svc, add, profileId, profiles } = setup();
    profiles.updatePreferences(profileId, { ...profiles.get(profileId)!.preferences, salaryMin: 2_000_000, salaryCurrency: 'INR' }, 70);
    const r = await svc.evaluate(add(1, 'low', { salaryText: 'INR 600000 - 800000 per year' }), profileId);
    expect(r.decision).toBe('filtered');
    expect(t.db.select().from(matches).get()?.filterReason).toMatch(/minimum salary/i);
  });

  it('the default feed hides skipped jobs', async () => {
    const { svc, add, profileId } = setup();
    await svc.evaluate(add(1, 'x'), profileId);
    svc.skip(t.db.select().from(matches).get()!.id);
    expect(svc.feed(profileId, {}).items).toHaveLength(0);
    expect(svc.feed(profileId, { state: 'SKIPPED' }).items).toHaveLength(1);
  });

  it('applications survive deleting their source and keep what they applied to', async () => {
    const { svc, add, profileId } = setup();
    await svc.evaluate(add(1, 'gh-1'), profileId);
    const app = svc.approve(t.db.select().from(matches).get()!.id);
    const { createSourceService } = await import('../sources/service');
    const { createSettings } = await import('../settings');
    createSourceService({ db: t.db, settings: createSettings(t.db) }).remove(1);
    const kept = t.db.select().from(applications).where(eq(applications.id, app.id)).get();
    expect(kept).toMatchObject({ listingId: null, jobTitle: 'Backend Engineer', company: 'Acme', sourceName: 'Acme careers', sourceUrl: 'https://x.example/gh-1' });
  });

  it('redoes matches that were scored offline once AI is available', async () => {
    const { svc, add, profileId, profiles, queue } = setup();
    const job = add(1, 'x');
    await svc.evaluate(job, profileId);
    expect(t.db.select().from(matches).get()?.method).toBe('heuristic');
    const ai = { status: () => ({ configured: true }) as never, generateObject: async () => { throw new Error('still learning'); } };
    const withAi = createMatchService({ db: t.db, ai, queue, profiles, log: createLogger({ level: 'silent' }), now: () => clock });
    expect((await withAi.evaluate(job, profileId)).skipped).toBeFalsy();
  });

  it('lists jobs whose match is missing or out of date for the current profile', async () => {
    const { svc, add, profileId, profiles } = setup();
    const a = add(1, 'a');
    const b = add(1, 'b', { title: 'Platform Engineer' });
    await svc.evaluate(a, profileId);
    expect(svc.staleJobIds(profileId)).toEqual([b]);
    const p = profiles.get(profileId)!;
    profiles.updateData(profileId, { ...p.data, summary: 'changed' });
    expect(svc.staleJobIds(profileId).sort()).toEqual([a, b].sort());
  });
});

describe('evaluations that are interrupted or overtaken (final review, core minors)', () => {
  const aiThat = (onCall: () => void) => ({
    status: () => ({ configured: true, dailyBudgetUsd: null, spentTodayUsd: 0 }) as never,
    generateObject: async () => {
      onCall();
      throw new Error('model unavailable');
    },
  });

  it('a slider change made while a job is being evaluated applies to that evaluation', async () => {
    const { add, profileId, profiles, queue } = setup();
    const job = add(1, 'x');
    // The user moves the slider to its strictest setting while the AI is working on the job.
    const ai = aiThat(() => profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 200));
    const svc = createMatchService({ db: t.db, ai, queue, profiles, log: createLogger({ level: 'silent' }), now: () => clock });
    const r = await svc.evaluate(job, profileId);
    const stored = t.db.select().from(matches).get()!;
    expect(stored.sliderValue).toBe(200);
    expect(stored.decision).toBe(stored.score >= 95 ? 'surfaced' : 'filtered');
    expect(r.decision).toBe(stored.decision);
  });

  it('an evaluation stopped part-way (shutdown, timeout) is not saved as an offline score', async () => {
    const { add, profileId, profiles, queue } = setup();
    const job = add(1, 'x');
    const ac = new AbortController();
    const svc = createMatchService({ db: t.db, ai: aiThat(() => ac.abort()), queue, profiles, log: createLogger({ level: 'silent' }), now: () => clock });
    await expect(svc.evaluate(job, profileId, { signal: ac.signal })).rejects.toThrow();
    expect(t.db.select().from(matches).all()).toHaveLength(0);
    expect(t.db.select().from(jobAnalyses).all()).toHaveLength(0);
  });
});

describe('the language a posting is written in (final review, new-user minor)', () => {
  const PT = `Estamos buscando uma pessoa engenheira backend para fazer parte do nosso time. Você vai trabalhar com Go e PostgreSQL, e também com a nossa plataforma de pagamentos.
Requisitos
• 3+ anos de experiência com Go
• PostgreSQL
São benefícios da vaga: plano de saúde e vale refeição. Não precisa ter experiência com pagamentos.`;

  it('a posting in Portuguese counts as needing Portuguese, weighed against the profile’s languages', async () => {
    const { svc, add, profileId, profiles } = setup();
    const p = profiles.get(profileId)!;
    profiles.updateData(profileId, { ...p.data, languages: [{ id: '', name: 'English', proficiency: 'fluent' }] });
    const job = add(1, 'pt', { description: PT, location: 'Bangalore, India' });
    const without = await svc.evaluate(job, profileId);
    const stored = t.db.select().from(matches).where(eq(matches.id, without.matchId)).get()!;
    expect(JSON.stringify(stored.breakdown)).toMatch(/Portuguese/);
    expect(without.decision).toBe('filtered');

    profiles.updateData(profileId, { ...p.data, languages: [{ id: '', name: 'English', proficiency: 'fluent' }, { id: '', name: 'Português', proficiency: 'native' }] });
    const withPt = await svc.evaluate(job, profileId);
    expect(withPt.score).toBeGreaterThan(without.score);
  });
});

describe('lowering the slider (round 2)', () => {
  it('never announces a job that is no longer listed, and leaves it unannounced in case it comes back', async () => {
    const { svc, add, profileId, profiles } = setup();
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 200);
    const job = add(1, 'x');
    await svc.evaluate(job, profileId);
    // Filtered at the strictest setting (80%), then the job closes.
    t.db.update(matches).set({ score: 80, decision: 'filtered', firstSurfacedAt: null }).run();
    t.db.update(jobs).set({ status: 'expired' }).where(eq(jobs.id, job)).run();
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 70);
    expect(svc.redecide(profileId).newlySurfaced).toEqual([]);
    expect(t.db.select().from(matches).get()?.firstSurfacedAt).toBeNull();
  });
});

describe('posting language against the profile (round 2)', () => {
  const PT = `Estamos buscando uma pessoa engenheira backend para fazer parte do nosso time. Você vai trabalhar com Go e PostgreSQL, e também com a nossa plataforma de pagamentos.
Requisitos
• 3+ anos de experiência com Go
• PostgreSQL
São benefícios da vaga: plano de saúde e vale refeição. Não precisa ter experiência com pagamentos.`;

  it('counts a language however it is written in the profile, and the language the CV itself is written in', async () => {
    const { svc, add, profileId, profiles } = setup();
    const job = add(1, 'pt', { description: PT, location: 'Bangalore, India' });
    const p = profiles.get(profileId)!;
    const scoreWith = async (data: typeof p.data) => {
      profiles.updateData(profileId, data);
      return (await svc.evaluate(job, profileId)).score;
    };
    const capped = await scoreWith({ ...p.data, languages: [{ id: '', name: 'English', proficiency: null }] });
    expect(await scoreWith({ ...p.data, languages: [{ id: '', name: 'Portuguese (fluent)', proficiency: null }] })).toBeGreaterThan(capped);
    expect(await scoreWith({ ...p.data, languages: [{ id: '', name: 'Brazilian Portuguese', proficiency: null }] })).toBeGreaterThan(capped);
    // A CV written in Portuguese that lists only "Inglês": its own language counts too.
    const written = { ...p.data, summary: 'Sou uma pessoa desenvolvedora backend com experiência em Go e PostgreSQL, e trabalho com sistemas de pagamentos para clientes no Brasil. Também tenho conhecimento de Kubernetes e gosto de fazer parte de um time que aprende junto.', languages: [{ id: '', name: 'Inglês', proficiency: null }] };
    expect(await scoreWith(written)).toBeGreaterThan(capped);
  });
});

describe('speaking the posting’s language never makes up for unmet requirements (round 2, new-user #1)', () => {
  it('a German speaker with none of a German posting’s skills stays below the threshold', async () => {
    const { svc, add, profileId, profiles } = setup();
    const p = profiles.get(profileId)!;
    profiles.updateData(profileId, { ...p.data, languages: [{ id: '', name: 'German', proficiency: 'native' }, { id: '', name: 'English', proficiency: 'C2' }] });
    const DE = `Wir suchen eine erfahrene Person für unser Team in Berlin. Du arbeitest mit unseren Kunden und bist für die Weiterentwicklung der Produkte verantwortlich.
Das bringst du mit
• Erfahrung mit Figma
• Erfahrung mit Adobe XD
• Kenntnisse in User Research
• Kenntnisse in Design Systems
Wir bieten flexible Arbeitszeiten und ein tolles Team, das sich auf dich freut. Bewirb dich jetzt bei uns und werde Teil des Teams.`;
    const r = await svc.evaluate(add(1, 'de', { description: DE, location: 'Bangalore, India' }), profileId);
    expect(r.decision).toBe('filtered');
    expect(r.score).toBeLessThan(76);
  });
});

describe('moving the slider keeps what limited a score (round 4)', () => {
  it('a filtered job still says it was limited by a must-have, or by the salary', async () => {
    const { svc, add, profileId, profiles } = setup();
    const job = add(1, 'x');
    await svc.evaluate(job, profileId);
    const breakdown = { score: { score: 60, components: {}, cappedBy: 'Portuguese (Português): the posting is written in Portuguese', capKind: 'requirement' } };
    t.db.update(matches).set({ score: 60, decision: 'filtered', breakdown, filterReason: 'x' }).run();
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 120);
    svc.redecide(profileId);
    expect(t.db.select().from(matches).get()?.filterReason).toMatch(/below your \d+% threshold \(limited by: Portuguese/);
    t.db.update(matches).set({ breakdown: {}, filterReason: 'Pays below your minimum salary (60%)' }).run();
    profiles.updatePreferences(profileId, profiles.get(profileId)!.preferences, 150);
    svc.redecide(profileId);
    expect(t.db.select().from(matches).get()?.filterReason).toBe('Pays below your minimum salary (60%)');
  });
});
