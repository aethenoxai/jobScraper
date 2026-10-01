import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, detectWorkMode, guarded, joinNonEmpty, prettySlug, toDate } from './shared';

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  employmentType?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  compensation?: { scrapeableCompensationSalarySummary?: string; compensationTierSummary?: string };
}

export const ashby: JobSourceAdapter<{ board: string; companyName?: string }> = {
  id: 'ashby',
  displayName: 'Ashby job board',
  description: 'Company career boards hosted on Ashby (jobs.ashbyhq.com/<board>).',
  homepage: 'https://www.ashbyhq.com',
  configFields: [
    { key: 'board', label: 'Board name', placeholder: 'ramp', help: 'The name in jobs.ashbyhq.com/<board>' },
    { key: 'companyName', label: 'Company name', optional: true },
  ],
  configSchema: z.object({ board: z.string().trim().regex(/^[a-z0-9_.-]+$/i), companyName: z.string().trim().optional() }),
  identityKey: 'board',
  completeSnapshot: true,
  minIntervalMinutes: 30,
  async *fetch({ config, http, signal }) {
    const data = await guarded(() => http.getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(config.board)}?includeCompensation=true`, { signal }));
    for (const j of data.jobs ?? []) {
      if (j.isListed === false) continue;
      const workplace = j.workplaceType?.toLowerCase();
      yield {
        sourceJobId: j.id,
        sourceUrl: j.jobUrl,
        applicationUrl: j.applyUrl ?? j.jobUrl,
        title: j.title.trim(),
        company: config.companyName || prettySlug(config.board),
        location: joinNonEmpty([j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)], ' / '),
        workMode: workplace === 'hybrid' ? 'hybrid' : workplace === 'remote' || (j.isRemote && workplace !== 'onsite') ? 'remote' : workplace === 'onsite' ? 'onsite' : detectWorkMode(j.location),
        employmentType: detectEmploymentType(j.employmentType),
        salaryText: j.compensation?.scrapeableCompensationSalarySummary ?? null,
        description: j.descriptionPlain ?? '',
        postedAt: toDate(j.publishedAt),
      };
    }
  },
};
