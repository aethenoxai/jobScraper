import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { eq } from 'drizzle-orm';
import { applications, jobs, masterCvs, matches, notifications, profiles as profilesTable, queueTasks } from '../db/schema';
import { createFileStore, StoragePaths } from '../storage';
import { DEFAULT_PREFERENCES, emptyProfile } from './model';
import { createProfileService, ProfileNotFoundError, ProfileValidationError } from './service';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const make = () => {
  const files = createFileStore(path.join(t.dir, 'files'));
  return { files, svc: createProfileService({ db: t.db, files }) };
};

describe('profile service', () => {
  it('creates profiles with empty data and default preferences; the first becomes default', () => {
    const { svc } = make();
    const a = svc.create('Software Engineer');
    const b = svc.create('Product Manager');
    expect(a).toMatchObject({ name: 'Software Engineer', isDefault: true, sliderValue: 100, userEdited: false, preferences: DEFAULT_PREFERENCES });
    expect(b.isDefault).toBe(false);
    expect(svc.list().map((p) => p.name)).toEqual(['Software Engineer', 'Product Manager']);
  });

  it('keeps exactly one default profile', () => {
    const { svc } = make();
    const a = svc.create('A');
    const b = svc.create('B');
    svc.setDefault(b.id);
    expect(svc.get(a.id)?.isDefault).toBe(false);
    expect(svc.getDefault()?.id).toBe(b.id);
  });

  it('validates and stores profile data, assigning ids and marking user edits', () => {
    const { svc } = make();
    const p = svc.create('A');
    const data = emptyProfile();
    data.skills = [{ id: '', name: 'Excel', category: 'tool' }];
    const saved = svc.updateData(p.id, data, { byUser: true });
    expect(saved.data.skills[0].id).toMatch(/^skl_/);
    expect(saved.userEdited).toBe(true);
    expect(() => svc.updateData(p.id, { personal: 'nope' })).toThrow(ProfileValidationError);
  });

  it('updates preferences and clamps the slider to 70–200', () => {
    const { svc } = make();
    const p = svc.create('A');
    const prefs = { ...DEFAULT_PREFERENCES, locations: ['Bangalore', 'Remote'] };
    expect(svc.updatePreferences(p.id, prefs, 150)).toMatchObject({ sliderValue: 150, preferences: prefs });
    expect(() => svc.updatePreferences(p.id, prefs, 60)).toThrow(ProfileValidationError);
    expect(() => svc.updatePreferences(p.id, { ...prefs, workModes: ['space'] }, 100)).toThrow(ProfileValidationError);
  });

  it('duplicates a profile with its data and preferences but not as default', () => {
    const { svc } = make();
    const a = svc.create('A');
    svc.updatePreferences(a.id, { ...DEFAULT_PREFERENCES, locations: ['Delhi NCR'] }, 120);
    const copy = svc.duplicate(a.id);
    expect(copy).toMatchObject({ name: 'A (copy)', isDefault: false, sliderValue: 120 });
    expect(copy.preferences.locations).toEqual(['Delhi NCR']);
  });

  it('renames and rejects blank names', () => {
    const { svc } = make();
    const a = svc.create('A');
    expect(svc.rename(a.id, '  Data Analyst ').name).toBe('Data Analyst');
    expect(() => svc.rename(a.id, '  ')).toThrow(ProfileValidationError);
  });

  it('deleting a profile removes its CV rows and files and promotes another default', async () => {
    const { svc, files } = make();
    const a = svc.create('A');
    const b = svc.create('B');
    await files.write(`${StoragePaths.masterCvDir(a.id)}/cv.pdf`, 'pdf');
    t.db.insert(masterCvs).values({ profileId: a.id, path: 'x', originalName: 'cv.pdf', mime: 'application/pdf', sizeBytes: 3, status: 'uploaded', uploadedAt: new Date() }).run();
    // An application of this profile, with its tailored CV on disk.
    const app = t.db
      .insert(applications)
      .values({ profileId: a.id, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://x.example', method: 'browser', status: 'READY', approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    await files.write(`${StoragePaths.applicationDir(app.id)}/Y_X_CV.pdf`, 'pdf');
    await svc.delete(a.id);
    expect(svc.get(a.id)).toBeNull();
    expect(t.db.select().from(applications).all()).toHaveLength(0);
    expect(await files.exists(StoragePaths.applicationDir(app.id))).toBe(false);
    expect(t.db.select().from(masterCvs).all()).toHaveLength(0);
    expect(await files.exists(StoragePaths.profileDir(a.id))).toBe(false);
    expect(svc.getDefault()?.id).toBe(b.id);
  });

  it('deleting a profile also removes notifications about its matches and applications (they would lead to missing pages)', async () => {
    const { svc } = make();
    const a = svc.create('A');
    const b = svc.create('B');
    const at = new Date();
    const job = t.db.insert(jobs).values({ fingerprint: 'f', companyKey: 'y', title: 'X', company: 'Y', status: 'active', firstSeenAt: at, lastSeenAt: at, lastChangedAt: at }).returning().get();
    const match = (profileId: number) => t.db.insert(matches).values({ profileId, jobId: job.id, score: 90, decision: 'surfaced', method: 'heuristic', breakdown: {}, sliderValue: 100, jobVersion: 0, profileVersion: 0, reviewState: 'NEW', evaluatedAt: at }).returning().get().id;
    const [ma, mb] = [match(a.id), match(b.id)];
    const app = t.db.insert(applications).values({ profileId: a.id, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://x.example', method: 'browser', status: 'READY', approvedAt: at, createdAt: at, updatedAt: at }).returning().get();
    const links = [`/feed/${ma}`, `/feed?profile=${a.id}&fresh=new`, `/applications/${app.id}`, `/feed/${mb}`, '/sources'];
    t.db.insert(notifications).values(links.map((link, i) => ({ event: 'x', entityKey: `k${i}`, channel: 'inapp' as const, title: 't', body: 'b', link, status: 'sent' as const, createdAt: at }))).run();
    await svc.delete(a.id);
    expect(t.db.select().from(notifications).all().map((n) => n.link)).toEqual([`/feed/${mb}`, '/sources']);
  });

  it('checks what the user types: a real email, jobs that end after they start, a 3-letter currency, in plain words (final review, new-user minor)', () => {
    const { svc } = make();
    const p = svc.create('A');
    const job = { id: '', title: 'Engineer', company: 'Acme', location: null, startDate: '2022-05', endDate: '2021', current: false, summary: null, bullets: [] };
    const data = (over: Record<string, unknown>) => ({ ...emptyProfile(), ...over });
    const error = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(error(() => svc.updateData(p.id, data({ personal: { ...emptyProfile().personal, email: 'not-an-email' } }), { byUser: true }))).toMatch(/^Email: /);
    expect(error(() => svc.updateData(p.id, data({ experience: [job] }), { byUser: true }))).toMatch(/Job 1 \(Engineer\): ends before it starts/);
    expect(error(() => svc.updateData(p.id, data({ experience: [{ ...job, startDate: '2020-13', endDate: null }] }), { byUser: true }))).toMatch(/^Job 1 \(Engineer\), start date: Use YYYY or YYYY-MM/);
    expect(svc.updateData(p.id, data({ experience: [{ ...job, startDate: '2021-03', endDate: '2021' }] }), { byUser: true }).data.experience).toHaveLength(1);
    expect(error(() => svc.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, salaryCurrency: '1$x' }, 100))).toMatch(/Currency: use a 3-letter code/);
    expect(svc.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, salaryCurrency: 'eur' }, 100).preferences.salaryCurrency).toBe('EUR');
  });

  it('deleting a profile cancels its applications’ waiting work and forgets their email drafts (N10, round 2)', async () => {
    const { svc } = make();
    const a = svc.create('A');
    const b = svc.create('B');
    const at = new Date();
    const app = (profileId: number) => t.db.insert(applications).values({ profileId, jobTitle: 'X', company: 'Y', sourceName: 'S', sourceUrl: 'https://x.example', method: 'email', status: 'READY', approvedAt: at, createdAt: at, updatedAt: at }).returning().get().id;
    const [mine, theirs] = [app(a.id), app(b.id)];
    const task = (applicationId: number, status: 'pending' | 'done') =>
      t.db.insert(queueTasks).values({ type: 'application.email', payload: { applicationId, draft: { to: 'jobs@x.example', subject: 's', body: 'my private letter' } }, status, runAt: at, createdAt: at, updatedAt: at }).returning().get().id;
    const [waiting, done, other] = [task(mine, 'pending'), task(mine, 'done'), task(theirs, 'pending')];
    await svc.delete(a.id);
    const row = (id: number) => t.db.select().from(queueTasks).where(eq(queueTasks.id, id)).get()!;
    expect(row(waiting)).toMatchObject({ status: 'failed', lastError: 'Cancelled' });
    expect(JSON.stringify([row(waiting).payload, row(done).payload])).not.toMatch(/private letter|jobs@x/);
    expect(row(other)).toMatchObject({ status: 'pending' });
    expect(JSON.stringify(row(other).payload)).toMatch(/private letter/);
  });

  it('throws a not-found error for unknown ids', () => {
    const { svc } = make();
    expect(() => svc.rename(999, 'x')).toThrow(ProfileNotFoundError);
  });

  it('reports every change that affects matching', () => {
    const changed: number[] = [];
    const svc = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'files')), onChanged: (id) => changed.push(id) });
    const a = svc.create('A');
    svc.updateData(a.id, emptyProfile());
    svc.updatePreferences(a.id, DEFAULT_PREFERENCES, 120);
    svc.updateDataIf(a.id, emptyProfile(), () => true);
    const copy = svc.duplicate(a.id);
    expect(changed).toEqual([a.id, a.id, a.id, copy.id]);
  });
});

describe('a stored profile that no longer fits the schema (M5 deferred minor)', () => {
  it('shows everything still readable and says what could not be read, instead of an empty profile', () => {
    const svc = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'files')) });
    const p = svc.create('Old');
    const raw = {
      ...emptyProfile(),
      headline: 'Backend Engineer',
      skills: [{ id: 's1', name: 'Go', category: 'technology' }, { id: 's2', name: 42 }],
      experience: [{ id: 'e1', title: 'Engineer', company: 'Acme', location: null, startDate: '2021-01', endDate: null, current: true, summary: null, bullets: [] }],
      careerLevel: 'grand-wizard',
    };
    t.db.update(profilesTable).set({ data: raw }).where(eq(profilesTable.id, p.id)).run();
    const got = svc.get(p.id)!;
    expect(got.data.headline).toBe('Backend Engineer');
    expect(got.data.skills.map((x) => x.name)).toEqual(['Go']);
    expect(got.data.experience).toHaveLength(1);
    expect(got.data.careerLevel).toBeNull();
    expect(got.dataIssues).toEqual([expect.stringMatching(/careerLevel/), expect.stringMatching(/skills: 1 item/)]);
    expect(svc.get(svc.create('Fine').id)!.dataIssues).toEqual([]);
  });
});
