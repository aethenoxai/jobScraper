import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, detectWorkMode, dropLastLine, guarded, htmlToText, toDate } from './shared';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
}

const MAX_PAGES = 3;

export const arbeitnow: JobSourceAdapter<Record<string, never>> = {
  id: 'arbeitnow',
  displayName: 'Arbeitnow',
  description: 'Jobs in Europe (mostly Germany) and remote jobs from Arbeitnow.',
  homepage: 'https://www.arbeitnow.com',
  configFields: [],
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  // The same posting is listed once per country site (arbeitnow.fr, arbeitnow.ch, …).
  repeatsPostings: true,
  minIntervalMinutes: 60,
  defaultInstances: [{ name: 'Arbeitnow', config: {}, enabled: true }],
  async *fetch({ http, signal, knownIds }) {
    let url: string | null = 'https://www.arbeitnow.com/api/job-board-api';
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const data: { data: ArbeitnowJob[]; links?: { next?: string | null } } = await guarded(() => http.getJson(url!, { signal }));
      let sawKnown = false;
      for (const j of data.data ?? []) {
        if (knownIds.has(j.slug)) sawKnown = true;
        yield {
          sourceJobId: j.slug,
          sourceUrl: j.url,
          applicationUrl: j.url,
          title: j.title.trim(),
          company: j.company_name.trim(),
          location: j.location?.trim() || null,
          workMode: j.remote ? 'remote' : detectWorkMode(j.location),
          employmentType: detectEmploymentType(...(j.job_types ?? [])),
          // Each country site ends with its own "Find … Jobs in <country> on Arbeitnow" line (sometimes mangled to
          // "E-Mail: Jobs in Germany on Arbeitnow"): dropped, so copies match.
          description: j.description ? dropLastLine(htmlToText(j.description), /\bJobs\b.* on Arbeitnow\.?$/i) : '',
          postedAt: toDate(j.created_at),
        };
      }
      // Newest first: once a page contains jobs we already know, older pages hold nothing new.
      url = sawKnown ? null : (data.links?.next ?? null);
    }
  },
};
