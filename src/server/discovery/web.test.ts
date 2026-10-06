import { describe, expect, it, vi } from 'vitest';
import { collect, fixtureHttp, fixturePages } from '../sources/testing/contract';
import type { Ai } from '../ai';
import { fakeRoutes } from '../ai/fake';
import { SourceError } from '../sources/types';
import { planQueries, web } from './web';

const jobPage = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Backend Engineer', hiringOrganization: { name: 'Tiny Startup' }, description: '<p>Go and Postgres</p>', jobLocation: { address: { addressLocality: 'Pune' } } })}</script></head></html>`;
const brave = {
  web: {
    results: [
      { url: 'https://boards.greenhouse.io/tinystartup/jobs/1', title: 'Backend Engineer - Tiny Startup', description: '' },
      { url: 'https://careers.tinystartup.test/jobs/backend', title: 'Backend Engineer', description: '' },
      { url: 'https://www.linkedin.com/jobs/view/123', title: 'Backend Engineer', description: '' },
      { url: 'https://careers.tinystartup.test/jobs/backend', title: 'dup', description: '' },
    ],
  },
};
const env = { BRAVE_SEARCH_API_KEY: 'brave-key' };
const hints = { titles: ['Backend Engineer'], locations: ['Pune'] };

describe('web discovery', () => {
  it('registers ATS boards, extracts JSON-LD jobs and never fetches LinkedIn', async () => {
    const seen: string[] = [];
    const registered: string[] = [];
    const http = fixtureHttp({ 'api.search.brave.com': brave, 'careers.tinystartup.test/robots.txt': 'User-agent: *\nAllow: /', 'careers.tinystartup.test/jobs/backend': jobPage }, seen);
    const out = await collect(web, { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 5 }, http, { env, hints, registerSource: (a, n) => registered.push(`${a}:${n}`) });
    expect(registered).toEqual(['greenhouse:tinystartup']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Backend Engineer', company: 'Tiny Startup', location: 'Pune', description: 'Go and Postgres' });
    expect(seen.some((u) => u.includes('linkedin'))).toBe(false);
    expect(seen.filter((u) => u.includes('/jobs/backend'))).toHaveLength(1);
  });

  it('does not re-read pages it already knows; it only confirms they are still listed', async () => {
    const seen: string[] = [];
    const http = fixtureHttp({ 'api.search.brave.com': brave, 'careers.tinystartup.test/robots.txt': '', 'careers.tinystartup.test/jobs/backend': jobPage }, seen);
    const out = await collect(web, { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 5 }, http, { env, hints, knownIds: new Set(['https://careers.tinystartup.test/jobs/backend']) });
    expect(seen.some((u) => u.endsWith('/jobs/backend'))).toBe(false);
    expect(out).toEqual([expect.objectContaining({ sourceJobId: 'https://careers.tinystartup.test/jobs/backend', touchOnly: true })]);
  });

  it('respects robots.txt', async () => {
    const http = fixtureHttp({ 'api.search.brave.com': brave, 'careers.tinystartup.test/robots.txt': 'User-agent: *\nDisallow: /jobs', 'careers.tinystartup.test/jobs/backend': jobPage });
    const out = await collect(web, { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 5 }, http, { env, hints });
    expect(out).toHaveLength(0);
  });

  it('respects the page budget', async () => {
    const seen: string[] = [];
    const http = fixtureHttp({ 'api.search.brave.com': brave, 'robots.txt': '', 'careers.tinystartup.test/jobs/backend': jobPage }, seen);
    await collect(web, { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 0 }, http, { env, hints });
    expect(seen.filter((u) => u.includes('/jobs/backend'))).toHaveLength(0);
  });

  it('explains a missing search API key', async () => {
    const err = await collect(web, { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 5 }, fixtureHttp({}), { hints }).catch((e: unknown) => e);
    expect((err as SourceError).code).toBe('SOURCE_CONFIG');
    expect((err as SourceError).message).toMatch(/BRAVE_SEARCH_API_KEY/);
  });

  it('works with a SearXNG instance', async () => {
    const seen: string[] = [];
    const http = fixtureHttp({ 'searx.local/search': { results: [{ url: 'https://jobs.lever.co/acme/1', title: 'x', content: '' }] } }, seen);
    const registered: string[] = [];
    await collect(web, { provider: 'searxng', searxngUrl: 'http://searx.local', maxQueries: 1, maxPages: 5 }, http, { hints, registerSource: (a, n) => registered.push(`${a}:${n}`) });
    expect(registered).toEqual(['lever:acme']);
    expect(seen[0]).toContain('format=json');
  });
});

describe('planQueries', () => {
  it('combines titles with locations, targets ATS boards first, and caps the count', () => {
    const q = planQueries({ titles: ['Data Analyst', 'BI Analyst'], locations: ['Kochi', 'Remote'], keywords: [] }, 3);
    expect(q).toHaveLength(3);
    expect(q[0]).toContain('site:boards.greenhouse.io');
    expect(q[0]).toContain('Data Analyst');
    expect(q.join(' ')).toContain('Kochi');
  });

  it('returns nothing without target titles', () => {
    expect(planQueries({ titles: [], locations: ['Pune'], keywords: [] }, 5)).toEqual([]);
  });
});

describe('web discovery reads pages with Scrapling', () => {
  const config = { provider: 'brave' as const, searxngUrl: null, maxQueries: 1, maxPages: 5 };
  const site = (extra: Record<string, unknown> = {}) => ({ 'api.search.brave.com': brave, 'careers.tinystartup.test/robots.txt': 'User-agent: *\nAllow: /', 'careers.tinystartup.test/jobs/backend': jobPage, ...extra });

  it('reads job pages through the page reader, never through plain HTTP', async () => {
    const seen: string[] = [];
    const http = fixtureHttp(site(), seen);
    const pages = fixturePages(http);
    const out = await collect(web, config, http, { env, hints, pages });
    expect(pages.calls).toEqual(['https://careers.tinystartup.test/jobs/backend']);
    expect(out).toHaveLength(1);
    // LinkedIn is never handed to the page reader either.
    expect(pages.calls.some((u) => u.includes('linkedin'))).toBe(false);
  });

  it('still checks robots.txt before reading a page', async () => {
    const http = fixtureHttp(site({ 'careers.tinystartup.test/robots.txt': 'User-agent: *\nDisallow: /jobs' }));
    const pages = fixturePages(http);
    await collect(web, config, http, { env, hints, pages });
    expect(pages.calls).toEqual([]);
  });

  it('fails the run with a setup hint when Scrapling is missing, after registering the boards it found', async () => {
    const registered: string[] = [];
    const err = await collect(web, config, fixtureHttp(site()), { env, hints, pages: null, registerSource: (a, n) => registered.push(`${a}:${n}`) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).code).toBe('SOURCE_CONFIG');
    expect((err as SourceError).message).toMatch(/pnpm run setup/);
    expect(registered).toEqual(['greenhouse:tinystartup']);
  });

  it('fails the run the same way when the page reader says Scrapling is not installed', async () => {
    const http = fixtureHttp(site());
    const err = await collect(web, config, http, { env, hints, pages: fixturePages(http, { '/jobs/backend': { __pageError: 'NOT_INSTALLED' } }) }).catch((e: unknown) => e);
    expect((err as SourceError).code).toBe('SOURCE_CONFIG');
  });

  it.each(['BLOCKED', 'REFUSED', 'TIMEOUT', 'HTTP_ERROR'])('skips a page the reader reports as %s and keeps going', async (code) => {
    const results = { web: { results: [{ url: 'https://a.test/jobs/1', title: 'a' }, { url: 'https://careers.tinystartup.test/jobs/backend', title: 'b' }] } };
    const http = fixtureHttp(site({ 'api.search.brave.com': results, 'a.test/robots.txt': '' }));
    const out = await collect(web, config, http, { env, hints, pages: fixturePages(http, { 'a.test/jobs/1': { __pageError: code } }) });
    expect(out).toEqual([expect.objectContaining({ title: 'Backend Engineer' })]);
  });

  it('fails the run when the helper keeps crashing (twice in a run)', async () => {
    const results = { web: { results: [{ url: 'https://a.test/1', title: 'a' }, { url: 'https://b.test/2', title: 'b' }, { url: 'https://careers.tinystartup.test/jobs/backend', title: 'c' }] } };
    const http = fixtureHttp(site({ 'api.search.brave.com': results, 'robots.txt': '' }));
    const err = await collect(web, config, http, { env, hints, pages: fixturePages(http, { 'a.test/1': { __pageError: 'HELPER_FAILED' }, 'b.test/2': { __pageError: 'HELPER_FAILED' } }) }).catch((e: unknown) => e);
    expect((err as SourceError).code).toBe('SOURCE_UNAVAILABLE');
  });

  it('does not start the AI fallback once the run’s time budget is used up (the scan would drop the whole run)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const results = { web: { results: [{ url: 'https://a.test/1', title: 'a' }] } };
      const http = fixtureHttp(site({ 'api.search.brave.com': results, 'robots.txt': '', 'a.test/1': '<html><body>Senior Backend Engineer at Tiny Startup</body></html>' }));
      const inner = fixturePages(http);
      const pages = {
        fetchPage: async (url: string, opts: { signal: AbortSignal }) => {
          vi.setSystemTime(Date.now() + 5 * 60_000); // the page took the rest of the budget
          return inner.fetchPage(url, opts);
        },
      };
      const asked: string[] = [];
      const ai = { ...fakeRoutes(['web-job-extract']), generateObject: async (o: { prompt: string }) => (asked.push(o.prompt), { isSingleJobPosting: false, title: null, company: null, location: null }) } as unknown as Ai;
      await collect(web, config, http, { env, hints, pages, ai });
      expect(asked).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reading new pages when the run’s time budget is used up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const results = { web: { results: [{ url: 'https://a.test/1', title: 'a' }, { url: 'https://careers.tinystartup.test/jobs/backend', title: 'b' }] } };
      const http = fixtureHttp(site({ 'api.search.brave.com': results, 'robots.txt': '' }));
      const inner = fixturePages(http);
      const pages = {
        calls: inner.calls,
        fetchPage: async (url: string, opts: { signal: AbortSignal }) => {
          vi.setSystemTime(Date.now() + 5 * 60_000); // this page took the whole budget
          return inner.fetchPage(url, opts);
        },
      };
      const seen: string[] = [];
      const http2 = fixtureHttp(site({ 'api.search.brave.com': results, 'robots.txt': '' }), seen);
      await collect(web, { ...config, maxQueries: 2 }, http2, { env, hints: { ...hints, titles: ['Backend Engineer', 'Go Developer'] }, pages: { fetchPage: pages.fetchPage } });
      expect(inner.calls).toEqual(['https://a.test/1']);
      // The second search waits for the next run too.
      expect(seen.filter((u) => u.includes('api.search.brave.com'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
