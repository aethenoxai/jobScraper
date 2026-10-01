import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, guarded, htmlToText, toDate } from './shared';

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export const remotive: JobSourceAdapter<Record<string, never>> = {
  id: 'remotive',
  displayName: 'Remotive',
  description: 'Remote jobs from Remotive (listings appear with a 24-hour delay).',
  homepage: 'https://remotive.com',
  terms: 'Remotive asks API users to fetch at most ~4 times a day and to link back to and credit Remotive.',
  configFields: [],
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  // Remotive's API terms: "max. 4 times a day".
  minIntervalMinutes: 360,
  defaultInstances: [{ name: 'Remotive', config: {}, enabled: true }],
  async *fetch({ http, signal }) {
    const data = await guarded(() => http.getJson<{ jobs: RemotiveJob[] }>('https://remotive.com/api/remote-jobs?limit=500', { signal }));
    for (const j of data.jobs ?? []) {
      yield {
        sourceJobId: String(j.id),
        sourceUrl: j.url,
        applicationUrl: j.url,
        title: j.title.trim(),
        company: j.company_name.trim(),
        location: j.candidate_required_location?.trim() || 'Remote',
        workMode: 'remote',
        employmentType: detectEmploymentType(j.job_type),
        salaryText: j.salary?.trim() || null,
        description: j.description ? htmlToText(j.description) : '',
        postedAt: toDate(j.publication_date),
      };
    }
  },
};
