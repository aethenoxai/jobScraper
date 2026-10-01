import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { collect, fixtureHttp } from './testing/contract';
import { RawListingSchema, SourceError, type JobSourceAdapter } from './types';

const demo: JobSourceAdapter<{ board: string }> = {
  id: 'demo',
  displayName: 'Demo',
  description: 'test',
  homepage: 'https://demo.example',
  configFields: [{ key: 'board', label: 'Board' }],
  configSchema: z.object({ board: z.string().min(1) }),
  completeSnapshot: true,
  minIntervalMinutes: 0,
  async *fetch(ctx) {
    const data = await ctx.http.getJson<{ jobs: Array<{ id: number; title: string }> }>(`https://demo.example/${ctx.config.board}`).catch((e: unknown) => {
      throw SourceError.from(e);
    });
    for (const j of data.jobs) yield { sourceJobId: String(j.id), sourceUrl: `https://demo.example/j/${j.id}`, title: j.title, company: 'Demo', description: 'Build things' };
  },
};

describe('source contract helpers', () => {
  it('collects listings from fixture responses', async () => {
    const http = fixtureHttp({ 'demo.example/acme': { jobs: [{ id: 1, title: 'Engineer' }] } });
    const out = await collect(demo, { board: 'acme' }, http);
    expect(out).toHaveLength(1);
    expect(RawListingSchema.safeParse(out[0]).success).toBe(true);
  });

  it('turns HTTP failures into SOURCE_UNAVAILABLE errors', async () => {
    const http = fixtureHttp({ 'demo.example/acme': { __status: 503 } });
    const err = await collect(demo, { board: 'acme' }, http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).code).toBe('SOURCE_UNAVAILABLE');
  });

  it('only accepts web links', () => {
    expect(RawListingSchema.safeParse({ sourceJobId: '1', sourceUrl: 'javascript:alert(1)', title: 'x', company: 'x' }).success).toBe(false);
    expect(RawListingSchema.safeParse({ sourceJobId: '1', sourceUrl: 'https://ok.example', applicationUrl: 'data:text/html,hi', title: 'x', company: 'x' }).success).toBe(false);
  });

  it('rejects listings without the required fields', () => {
    expect(RawListingSchema.safeParse({ sourceJobId: '1', sourceUrl: 'not a url', title: '', company: 'x', description: 'y' }).success).toBe(false);
  });
});
