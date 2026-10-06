import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging';
import { registerBuiltInAdapters } from './adapters';
import { probeSource } from './probe';
import { fixtureHttp } from './testing/contract';

registerBuiltInAdapters();

const log = createLogger({ level: 'silent' });
const deps = (routes: Record<string, unknown>, env: Record<string, string | undefined> = {}) => ({
  http: fixtureHttp(routes),
  env,
  log,
  hints: { titles: ['Backend Engineer'], locations: [], keywords: [] },
});

describe('probeSource', () => {
  it('reports how many jobs a working source returned', async () => {
    const res = await probeSource('greenhouse', { board: 'acme' }, deps({
      'boards-api.greenhouse.io': { jobs: [{ id: 1, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote' }, updated_at: '2026-01-01T00:00:00Z', content: 'Build things' }] },
    }));
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1 job/);
  });

  it('refuses an invalid configuration by the label the form shows', async () => {
    const res = await probeSource('greenhouse', {}, deps({}));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Board name/);
  });

  it('refuses an unknown source type', async () => {
    expect(await probeSource('nope', {}, deps({}))).toEqual({ ok: false, message: expect.stringContaining('nope') });
  });

  it('says which key is missing instead of calling the API', async () => {
    const res = await probeSource('adzuna', { country: 'in', where: '' }, deps({}));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ADZUNA_APP_ID/);
  });

  it('never runs a page-reading source here: its browser belongs to the worker', async () => {
    const res = await probeSource('web', { provider: 'brave', searxngUrl: null, maxQueries: 1, maxPages: 1 }, deps({}, { BRAVE_SEARCH_API_KEY: 'k' }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/next scan/i);
  });

  it('turns a source failure into the message the user sees', async () => {
    const res = await probeSource('greenhouse', { board: 'acme' }, deps({ 'boards-api.greenhouse.io': { __status: 404 } }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/board name/i);
  });

  it('reports a source that answered with nothing', async () => {
    const res = await probeSource('greenhouse', { board: 'acme' }, deps({ 'boards-api.greenhouse.io': { jobs: [] } }));
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/no jobs/i);
  });
});

describe('probeSource honesty', () => {
  it('does not call a source that answers with listings the scan would throw away a success', async () => {
    const res = await probeSource('greenhouse', { board: 'acme' }, deps({
      // No title and no absolute_url: RawListingSchema rejects it, so the scan would count it unreadable.
      'boards-api.greenhouse.io': { jobs: [{ id: 1, title: '', absolute_url: 'not-a-url', content: '' }] },
    }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/could not be read|couldn’t be read|could be read/i);
  });
});
