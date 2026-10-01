/* eslint-disable @typescript-eslint/no-explicit-any -- ad-hoc JSON trimming of third-party payloads */
/**
 * Records small, trimmed samples of real public job-source API responses as test fixtures.
 * Run manually when an API changes: pnpm exec tsx scripts/record-source-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UA = 'JobScraper/0.1 (self-hosted job search; fixture recorder)';
const SOURCES: Array<[string, string, (j: any) => any]> = [
  ['greenhouse', 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true', (j) => ({ ...j, jobs: j.jobs.slice(0, 3), meta: { total: 3 } })],
  ['lever', 'https://api.lever.co/v0/postings/palantir?mode=json', (j) => j.slice(0, 3)],
  ['ashby', 'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true', (j) => ({ ...j, jobs: j.jobs.slice(0, 3) })],
  ['workable', 'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true', (j) => ({ ...j, jobs: j.jobs.slice(0, 3) })],
  ['recruitee', 'https://bunq.recruitee.com/api/offers/', (j) => ({ offers: j.offers.slice(0, 3) })],
  ['smartrecruiters', 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=3', (j) => j],
  ['remoteok', 'https://remoteok.com/api', (j) => j.slice(0, 4)],
  ['remotive', 'https://remotive.com/api/remote-jobs?limit=3', (j) => ({ ...j, jobs: j.jobs.slice(0, 3) })],
  ['arbeitnow', 'https://www.arbeitnow.com/api/job-board-api', (j) => ({ ...j, data: j.data.slice(0, 3), links: { ...j.links, next: null } })],
  ['himalayas', 'https://himalayas.app/jobs/api?limit=3', (j) => j],
];

const trimStrings = (v: any): any =>
  typeof v === 'string' ? (v.length > 3000 ? v.slice(0, 3000) : v) : Array.isArray(v) ? v.map(trimStrings) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimStrings(x)])) : v;

async function main() {
  for (const [name, url, trim] of SOURCES) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = trimStrings(trim(await res.json()));
      const dir = path.resolve('tests/fixtures/sources', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'page.json'), JSON.stringify(out, null, 1));
      console.log(`✓ ${name}`);
    } catch (e) {
      console.log(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
main();
