import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, dropLastLine, guarded, htmlToText, toDate } from './shared';

interface RemoteOkJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  apply_url?: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
  legal?: string;
}

export const remoteok: JobSourceAdapter<Record<string, never>> = {
  id: 'remoteok',
  displayName: 'Remote OK',
  description: 'Latest remote jobs from Remote OK.',
  homepage: 'https://remoteok.com',
  terms: 'Jobs from Remote OK always link back to Remote OK and name it as the source.',
  configFields: [],
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  minIntervalMinutes: 60,
  defaultInstances: [{ name: 'Remote OK', config: {}, enabled: true }],
  async *fetch({ http, signal }) {
    const data = await guarded(() => http.getJson<RemoteOkJob[]>('https://remoteok.com/api', { signal }));
    for (const j of data ?? []) {
      if (!j.id || !j.position || !j.company || j.legal) continue;
      yield {
        sourceJobId: String(j.id),
        sourceUrl: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
        applicationUrl: j.apply_url || j.url,
        title: j.position.trim(),
        company: j.company.trim(),
        location: j.location?.trim() || 'Remote',
        workMode: 'remote',
        employmentType: detectEmploymentType(...(j.tags ?? [])),
        salaryText: j.salary_min ? `USD ${j.salary_min} - ${j.salary_max || j.salary_min} per year` : null,
        // Remote OK appends an English anti-spam note to every posting; it isn't part of the job.
        description: j.description ? dropLastLine(htmlToText(j.description), /^Please mention the word\b.*\bsee they['’]re human\.?$/i) : '',
        postedAt: toDate(j.epoch ?? j.date),
      };
    }
  },
};
