import { describe, expect, it } from 'vitest';
import { collect, fixtureHttp } from '../sources/testing/contract';
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
