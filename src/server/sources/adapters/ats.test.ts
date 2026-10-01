import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertListingsValid, collect, fixtureHttp } from '../testing/contract';
import { SourceError } from '../types';
import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import { recruitee } from './recruitee';
import { smartrecruiters } from './smartrecruiters';
import { workable } from './workable';

const fx = (name: string, file = 'page.json') => JSON.parse(readFileSync(path.resolve('tests/fixtures/sources', name, file), 'utf8'));

describe('greenhouse', () => {
  it('maps board jobs to listings', async () => {
    const out = await collect(greenhouse, { board: 'gitlab' }, fixtureHttp({ 'boards/gitlab/jobs': fx('greenhouse') }));
    assertListingsValid(out);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ company: 'GitLab', sourceUrl: expect.stringContaining('greenhouse.io') });
    expect(out[0].description!.length).toBeGreaterThan(100);
    expect(out[0].description).not.toMatch(/<\w+|&lt;/);
  });

  it('reports a missing board as a configuration problem', async () => {
    const err = await collect(greenhouse, { board: 'nope' }, fixtureHttp({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).code).toBe('SOURCE_CONFIG');
  });

  it('reports server errors as unavailable', async () => {
    const err = await collect(greenhouse, { board: 'gitlab' }, fixtureHttp({ 'boards/gitlab': { __status: 503 } })).catch((e: unknown) => e);
    expect((err as SourceError).code).toBe('SOURCE_UNAVAILABLE');
  });
});

describe('lever', () => {
  it('maps postings including workplace type and commitment', async () => {
    const out = await collect(lever, { company: 'palantir' }, fixtureHttp({ 'postings/palantir': fx('lever') }));
    assertListingsValid(out);
    expect(out[0]).toMatchObject({ company: 'Palantir', workMode: 'hybrid', employmentType: 'full-time' });
    expect(out[0].applicationUrl).toMatch(/\/apply$/);
  });
});

describe('ashby', () => {
  it('maps listed jobs with compensation', async () => {
    const out = await collect(ashby, { board: 'ramp', companyName: 'Ramp' }, fixtureHttp({ 'job-board/ramp': fx('ashby') }));
    assertListingsValid(out);
    expect(out[0]).toMatchObject({ company: 'Ramp', title: 'Security Engineer, Cloud', workMode: 'hybrid' });
    expect(out[0].salaryText).toMatch(/\$/);
  });
});

describe('workable', () => {
  it('maps jobs with descriptions and remote flag', async () => {
    const out = await collect(workable, { account: 'huggingface' }, fixtureHttp({ 'accounts/huggingface': fx('workable') }));
    assertListingsValid(out);
    expect(out[0]).toMatchObject({ company: 'Hugging Face', workMode: 'remote', location: 'Paris, Île-de-France, France' });
    expect(out[0].description!.length).toBeGreaterThan(50);
  });
});

describe('recruitee', () => {
  it('maps offers', async () => {
    const out = await collect(recruitee, { company: 'bunq' }, fixtureHttp({ 'bunq.recruitee.com': fx('recruitee') }));
    assertListingsValid(out);
    expect(out[0]).toMatchObject({ company: 'bunq', title: 'iOS Developer', workMode: 'hybrid', employmentType: 'full-time' });
  });
});

describe('smartrecruiters', () => {
  const page = fx('smartrecruiters');
  const detail = fx('smartrecruiters', 'detail.json');
  const firstId = page.content[0].id as string;

  it('fetches details only for postings it has not seen', async () => {
    const seen: string[] = [];
    const routes = { 'postings?limit': page, [`postings/${firstId}`]: detail };
    const out = await collect(smartrecruiters, { company: 'BoschGroup' }, fixtureHttp(routes, seen), { knownIds: new Set(page.content.slice(1).map((p: { id: string }) => p.id)) });
    assertListingsValid(out);
    expect(out[0].description!.length).toBeGreaterThan(50);
    expect(out[1].description).toBeNull();
    expect(seen.filter((u) => /postings\/\d/.test(u))).toHaveLength(1);
  });
});
