import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routedAi } from '../ai/fake';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { jobListings, jobs } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createSettings } from '../settings';
import { registerBuiltInAdapters } from '../sources/adapters';
import { createSourceService } from '../sources/service';
import { fixtureHttp, fixturePages } from '../sources/testing/contract';
import { PageFetchError } from '../scrapling/client';
import { addJobByUrl, addJobManually, AddJobError, addUrlNotes, rememberAddUrlNote } from './add-url';

registerBuiltInAdapters();
const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const page = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Staff Nurse', hiringOrganization: { name: 'City Clinic' }, description: 'Night shifts on the acute ward.' })}</script>`;

function deps(routes: Record<string, unknown>) {
  const sources = createSourceService({ db: t.db, settings: createSettings(t.db) });
  const http = fixtureHttp(routes);
  return { db: t.db, sources, ingestor: createIngestor({ db: t.db }), http, pages: fixturePages(http, routes), log, ai: null, env: {}, signal: new AbortController().signal, lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
}

describe('addJobByUrl', () => {
  it('reads structured job data from a career page', async () => {
    const d = deps({ 'clinic.test/jobs/nurse': page });
    const r = await addJobByUrl('https://clinic.test/jobs/nurse', d);
    expect(r.jobIds).toHaveLength(1);
    expect(t.db.select().from(jobs).get()).toMatchObject({ title: 'Staff Nurse', company: 'City Clinic' });
    expect(d.sources.list().find((s) => s.adapterId === 'manual')).toBeTruthy();
  });

  it('adds the company board as a source for a known ATS link and imports its jobs', async () => {
    const gh = JSON.parse(readFileSync(path.resolve('tests/fixtures/sources/greenhouse/page.json'), 'utf8'));
    const d = deps({ 'boards/gitlab/jobs': gh });
    const firstUrl = gh.jobs[0].absolute_url as string;
    const r = await addJobByUrl(firstUrl.replace('job-boards.greenhouse.io', 'boards.greenhouse.io'), d);
    expect(d.sources.list().some((s) => s.adapterId === 'greenhouse')).toBe(true);
    expect(t.db.select().from(jobListings).all()).toHaveLength(3);
    expect(r.jobIds.length).toBeGreaterThan(0);
    expect(r.note).toBeUndefined();
  });

  it('says so when the linked job is no longer on its board, while still adding the board (M2 deferred minor)', async () => {
    const gh = JSON.parse(readFileSync(path.resolve('tests/fixtures/sources/greenhouse/page.json'), 'utf8'));
    const d = deps({ 'boards/gitlab/jobs': gh });
    const r = await addJobByUrl('https://boards.greenhouse.io/gitlab/jobs/999999999', d);
    expect(r.note).toMatch(/isn't listed on .* any more.*3 open jobs/);
    expect(t.db.select().from(jobListings).all()).toHaveLength(3);
    const settings = createSettings(t.db);
    rememberAddUrlNote(settings, 7, r.note!);
    expect(addUrlNotes(settings).get(7)).toBe(r.note);
  });

  it('explains that LinkedIn and similar pages must be pasted instead', async () => {
    await expect(addJobByUrl('https://www.linkedin.com/jobs/view/42', deps({}))).rejects.toThrow(/paste/i);
  });

  it('falls back to the AI only when the web-job-extract task is configured, not for other tasks', async () => {
    const routes = { 'blog.test/post': '<html><body>Senior Backend Engineer at Tiny Startup. Apply now.</body></html>' };
    const asked: string[] = [];
    const withTasks = (tasks: Parameters<typeof routedAi>[0]) => ({ ...deps(routes), ai: routedAi(tasks, (o) => (asked.push(o.prompt), { isSingleJobPosting: true, title: 'Senior Backend Engineer', company: 'Tiny Startup', location: null })) });
    await expect(addJobByUrl('https://blog.test/post', withTasks(['jd-analysis', 'cv-tailor']))).rejects.toBeInstanceOf(AddJobError);
    expect(asked).toEqual([]);
    await addJobByUrl('https://blog.test/post', withTasks(['web-job-extract']));
    expect(asked).toHaveLength(1);
  });

  it('rejects pages without job details when no AI is configured', async () => {
    await expect(addJobByUrl('https://blog.test/post', deps({ 'blog.test/post': '<html>hello</html>' }))).rejects.toBeInstanceOf(AddJobError);
  });

  it('rejects non-web URLs', async () => {
    await expect(addJobByUrl('file:///etc/passwd', deps({}))).rejects.toBeInstanceOf(AddJobError);
    await expect(addJobByUrl('http://127.0.0.1:3000/api/health', deps({}))).rejects.toBeInstanceOf(AddJobError);
  });
});

describe('addJobManually', () => {
  it('stores a pasted job description', () => {
    const d = deps({});
    const r = addJobManually({ title: 'Product Designer', company: 'Studio', location: 'Remote', url: 'https://www.linkedin.com/jobs/view/7', description: 'Design things in Figma.' }, d);
    expect(r.jobIds).toHaveLength(1);
    expect(t.db.select().from(jobListings).get()).toMatchObject({ title: 'Product Designer', sourceUrl: 'https://www.linkedin.com/jobs/view/7' });
  });

  it('refuses pages that redirect into the local network', async () => {
    const d = deps({ 'jobs.evil.test/posting': page });
    const evil = { ...d, lookup: async (h: string) => [{ address: h === 'jobs.evil.test' ? '10.0.0.8' : '93.184.216.34', family: 4 }] };
    await expect(addJobByUrl('https://jobs.evil.test/posting', evil)).rejects.toThrow(/doesn.t read that page/);
    expect(d.pages.calls).toEqual([]);
  });
});

describe('addJobByUrl reads pages with Scrapling', () => {
  it('reads the page through the page reader', async () => {
    const d = deps({ 'clinic.test/jobs/nurse': page });
    await addJobByUrl('https://clinic.test/jobs/nurse', d);
    expect(d.pages.calls).toEqual(['https://clinic.test/jobs/nurse']);
  });

  it('never hands LinkedIn and similar sites to the page reader', async () => {
    const d = deps({});
    await expect(addJobByUrl('https://www.linkedin.com/jobs/view/42', d)).rejects.toThrow(/paste/i);
    expect(d.pages.calls).toEqual([]);
  });

  it('says to run setup when Scrapling is missing', async () => {
    const d = { ...deps({ 'clinic.test/jobs/nurse': page }), pages: undefined };
    await expect(addJobByUrl('https://clinic.test/jobs/nurse', d)).rejects.toThrow(/pnpm run setup/);
    await expect(addJobByUrl('https://clinic.test/jobs/nurse', deps({ 'clinic.test/jobs/nurse': { __pageError: 'NOT_INSTALLED' } }))).rejects.toThrow(/pnpm run setup/);
  });

  it.each([
    ['BLOCKED', /blocked automated reading even with the stealth browser.*Paste a job/],
    ['REFUSED', /doesn.t read that page/],
    ['TIMEOUT', /Could not open the page/],
    ['HTTP_ERROR', /Could not open the page/],
  ])('explains a page the reader reports as %s', async (code, message) => {
    const err = await addJobByUrl('https://clinic.test/jobs/nurse', deps({ 'clinic.test/jobs/nurse': { __pageError: code } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AddJobError);
    expect((err as Error).message).toMatch(message);
  });

  it('tries once more when the helper crashed, then explains', async () => {
    const d = deps({ 'clinic.test/jobs/nurse': page });
    let failures = 1;
    const flaky = {
      calls: [] as string[],
      fetchPage: async (url: string, opts: { signal: AbortSignal }) => {
        flaky.calls.push(url);
        if (failures-- > 0) throw new PageFetchError('HELPER_FAILED', 'helper stopped');
        return d.pages.fetchPage(url, opts);
      },
    };
    await expect(addJobByUrl('https://clinic.test/jobs/nurse', { ...d, pages: flaky })).resolves.toMatchObject({ jobIds: [expect.any(Number)] });
    expect(flaky.calls).toHaveLength(2);
    failures = 2;
    flaky.calls = [];
    await expect(addJobByUrl('https://clinic.test/jobs/other', { ...d, pages: flaky })).rejects.toThrow(/Could not open the page/);
    expect(flaky.calls).toHaveLength(2);
  });
});
