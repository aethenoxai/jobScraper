import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAdapter, listAdapters } from '../registry';
import { assertListingsValid, collect, fixtureHttp } from '../testing/contract';
import { SourceError } from '../types';
import { adzuna } from './adzuna';
import { arbeitnow } from './arbeitnow';
import { dropLastLine } from './shared';
import { himalayas } from './himalayas';
import { registerBuiltInAdapters } from './index';
import { remoteok } from './remoteok';
import { remotive } from './remotive';

const fx = (name: string) => JSON.parse(readFileSync(path.resolve('tests/fixtures/sources', name, 'page.json'), 'utf8'));

describe('remoteok', () => {
  it('skips the legal notice entry and maps jobs as remote', async () => {
    const out = await collect(remoteok, {}, fixtureHttp({ 'remoteok.com/api': fx('remoteok') }));
    assertListingsValid(out);
    expect(out).toHaveLength(3);
    expect(out.every((l) => l.workMode === 'remote')).toBe(true);
    expect(out[0].sourceUrl).toMatch(/remoteok\.com/i);
  });

  it('leaves out Remote OK’s English anti-spam note, so a posting keeps its own language (round 2)', async () => {
    const out = await collect(remoteok, {}, fixtureHttp({ 'remoteok.com/api': fx('remoteok') }));
    expect(out.map((l) => l.description).join('\n')).not.toMatch(/mention the word|spam applicants/i);
    expect(out.some((l) => /automotriz/.test(l.description ?? ''))).toBe(true);
  });
});

describe('remotive', () => {
  it('maps jobs with required location and type', async () => {
    const out = await collect(remotive, {}, fixtureHttp({ 'remotive.com/api/remote-jobs': fx('remotive') }));
    assertListingsValid(out);
    expect(out[0]).toMatchObject({ workMode: 'remote' });
    expect(out[0].location).toBeTruthy();
  });
});

describe('arbeitnow', () => {
  it('maps jobs and stops paging when there is no next page', async () => {
    const seen: string[] = [];
    const out = await collect(arbeitnow, {}, fixtureHttp({ 'arbeitnow.com/api/job-board-api': fx('arbeitnow') }, seen));
    assertListingsValid(out);
    expect(out).toHaveLength(3);
    expect(seen).toHaveLength(1);
  });

  it('leaves out the country site’s closing line, which is all that differs between its copies of a posting (round 2)', async () => {
    const out = await collect(arbeitnow, {}, fixtureHttp({ 'arbeitnow.com/api/job-board-api': fx('arbeitnow') }));
    expect(out.map((l) => l.description).join('\n')).not.toMatch(/on Arbeitnow/i);
  });
});

describe('himalayas', () => {
  it('searches by the user’s target titles when available', async () => {
    const seen: string[] = [];
    const out = await collect(himalayas, {}, fixtureHttp({ 'himalayas.app/jobs/api': fx('himalayas') }, seen), { hints: { titles: ['React Developer'] } });
    assertListingsValid(out);
    expect(seen[0]).toContain('search?q=React%20Developer');
    expect(out[0].sourceJobId).toMatch(/^https:\/\/himalayas\.app/);
  });

  it('stops paging the newest jobs once it reaches known ones', async () => {
    const page = fx('himalayas');
    const seen: string[] = [];
    const known = new Set<string>(page.jobs.map((j: { guid: string }) => j.guid));
    await collect(himalayas, {}, fixtureHttp({ 'himalayas.app/jobs/api': page }, seen), { knownIds: known });
    expect(seen).toHaveLength(1);
  });
});

describe('adzuna', () => {
  it('needs API credentials', async () => {
    const err = await collect(adzuna, { country: 'in' }, fixtureHttp({})).catch((e: unknown) => e);
    expect((err as SourceError).code).toBe('SOURCE_CONFIG');
  });

  it('searches per target title and strips highlight markup', async () => {
    const seen: string[] = [];
    const out = await collect(adzuna, { country: 'in' }, fixtureHttp({ 'api.adzuna.com': fx('adzuna') }, seen), {
      hints: { titles: ['React Developer'], locations: ['Bengaluru'] },
      env: { ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' },
    });
    assertListingsValid(out);
    expect(out[0].title).toBe('Senior React Developer');
    expect(out[0]).toMatchObject({ company: 'Example Fintech Pvt Ltd', employmentType: 'full-time' });
    expect(out[0].salaryText).toContain('INR');
    expect(out[1].salaryText).toBeNull(); // predicted salaries are not shown as facts
    expect(seen[0]).toContain('what=React%20Developer');
  });
});

describe('registry', () => {
  it('registers every built-in adapter once with valid metadata', () => {
    registerBuiltInAdapters();
    const ids = listAdapters().map((a) => a.id).sort();
    expect(ids).toEqual(['adzuna', 'arbeitnow', 'ashby', 'greenhouse', 'himalayas', 'lever', 'manual', 'recruitee', 'remoteok', 'remotive', 'smartrecruiters', 'web', 'workable']);
    for (const a of listAdapters()) {
      expect(a.minIntervalMinutes).toBeGreaterThan(0);
      for (const inst of a.defaultInstances ?? []) expect(a.configSchema.safeParse(inst.config).success).toBe(true);
    }
    expect(getAdapter('remotive')?.minIntervalMinutes).toBeGreaterThanOrEqual(360);
  });
});

describe('dropLastLine (round 3)', () => {
  it('drops a matching closing line only, quickly even on huge text', () => {
    expect(dropLastLine('Job text\nFind more Jobs in France on Arbeitnow', /^Find (?:more )?.* on Arbeitnow\.?$/i)).toBe('Job text');
    expect(dropLastLine('Job text\nWe like Arbeitnow', /^Find (?:more )?.* on Arbeitnow\.?$/i)).toBe('Job text\nWe like Arbeitnow');
    expect(dropLastLine('Job text\nE-Mail: Jobs in Germany on Arbeitnow', /\bJobs\b.* on Arbeitnow\.?$/i)).toBe('Job text');
    const started = performance.now();
    dropLastLine(`Job\n${'\u3000'.repeat(50_000)}x`, /^Find (?:more )?.* on Arbeitnow\.?$/i);
    dropLastLine(`Job\n${'Jobs '.repeat(60_000)}`, /\bJobs\b.* on Arbeitnow\.?$/i);
    expect(performance.now() - started).toBeLessThan(100);
    // A one-line text is left alone (its only line is the job).
    expect(dropLastLine('Great job. Find Jobs in Germany on Arbeitnow', /\bJobs\b.* on Arbeitnow\.?$/i)).toBe('Great job. Find Jobs in Germany on Arbeitnow');
  });
});
