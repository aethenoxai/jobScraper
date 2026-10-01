import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, guarded, htmlToText, joinNonEmpty, toDate } from './shared';

interface HimalayasJob {
  guid: string;
  title: string;
  companyName: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  locationRestrictions?: string[];
  description?: string;
  excerpt?: string;
  pubDate?: number;
  expiryDate?: number;
  applicationLink?: string;
}

const PAGE = 20;
const MAX_NEWEST_PAGES = 5;
const MAX_SEARCH_TITLES = 3;
const MAX_SEARCH_PAGES = 2;

export const himalayas: JobSourceAdapter<Record<string, never>> = {
  id: 'himalayas',
  displayName: 'Himalayas',
  description: 'Remote jobs from Himalayas; searches your target job titles.',
  homepage: 'https://himalayas.app',
  configFields: [],
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  minIntervalMinutes: 120,
  defaultInstances: [{ name: 'Himalayas', config: {}, enabled: true }],
  async *fetch({ http, signal, hints, knownIds }) {
    const yielded = new Set<string>();
    const map = (j: HimalayasJob) => ({
      sourceJobId: j.guid,
      sourceUrl: j.guid,
      applicationUrl: j.applicationLink || j.guid,
      title: j.title.trim(),
      company: j.companyName.trim(),
      location: joinNonEmpty(j.locationRestrictions ?? []) ?? 'Remote (worldwide)',
      workMode: 'remote' as const,
      employmentType: detectEmploymentType(j.employmentType),
      salaryText: j.minSalary ? `${j.currency ?? ''} ${j.minSalary} - ${j.maxSalary ?? j.minSalary} per ${j.salaryPeriod === 'annual' ? 'year' : (j.salaryPeriod ?? 'year')}`.trim() : null,
      description: j.description ? htmlToText(j.description) : (j.excerpt ?? ''),
      postedAt: toDate(j.pubDate),
      expiresAt: toDate(j.expiryDate),
    });

    const titles = hints.titles.slice(0, MAX_SEARCH_TITLES);
    if (titles.length) {
      for (const title of titles) {
        for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
          const data = await guarded(() => http.getJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(title)}&offset=${page * PAGE}&limit=${PAGE}`, { signal }));
          for (const j of data.jobs ?? []) {
            if (yielded.has(j.guid)) continue;
            yielded.add(j.guid);
            yield map(j);
          }
          if ((data.jobs?.length ?? 0) < PAGE) break;
        }
      }
      return;
    }
    for (let page = 0; page < MAX_NEWEST_PAGES; page++) {
      const data = await guarded(() => http.getJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?offset=${page * PAGE}&limit=${PAGE}`, { signal }));
      let sawKnown = false;
      for (const j of data.jobs ?? []) {
        if (knownIds.has(j.guid)) sawKnown = true;
        if (yielded.has(j.guid)) continue;
        yielded.add(j.guid);
        yield map(j);
      }
      if (sawKnown || (data.jobs?.length ?? 0) < PAGE) break;
    }
  },
};
