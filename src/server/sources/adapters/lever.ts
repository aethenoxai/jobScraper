import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, detectWorkMode, guarded, htmlToText, joinNonEmpty, prettySlug, toDate } from './shared';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; allLocations?: string[] };
  descriptionPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

const WORKPLACE: Record<string, 'remote' | 'hybrid' | 'onsite'> = { remote: 'remote', hybrid: 'hybrid', 'on-site': 'onsite', onsite: 'onsite' };

export const lever: JobSourceAdapter<{ company: string; companyName?: string }> = {
  id: 'lever',
  displayName: 'Lever job board',
  description: 'Company career boards hosted on Lever (jobs.lever.co/<company>).',
  homepage: 'https://www.lever.co',
  configFields: [
    { key: 'company', label: 'Company handle', placeholder: 'palantir', help: 'The name in jobs.lever.co/<handle>' },
    { key: 'companyName', label: 'Company name', optional: true },
  ],
  configSchema: z.object({ company: z.string().trim().regex(/^[a-z0-9_.-]+$/i), companyName: z.string().trim().optional() }),
  identityKey: 'company',
  completeSnapshot: true,
  minIntervalMinutes: 30,
  async *fetch({ config, http, signal }) {
    const postings = await guarded(() => http.getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(config.company)}?mode=json`, { signal }));
    for (const p of postings ?? []) {
      const locations = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location];
      const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n');
      const salary = p.salaryRange?.min ? `${p.salaryRange.currency ?? ''} ${p.salaryRange.min} - ${p.salaryRange.max ?? p.salaryRange.min} per ${p.salaryRange.interval?.replace('per-', '') ?? 'year'}`.trim() : null;
      yield {
        sourceJobId: p.id,
        sourceUrl: p.hostedUrl,
        applicationUrl: p.applyUrl ?? p.hostedUrl,
        title: p.text,
        company: config.companyName || prettySlug(config.company),
        location: joinNonEmpty(locations, ' / '),
        workMode: WORKPLACE[p.workplaceType ?? ''] ?? detectWorkMode(p.categories?.location),
        employmentType: detectEmploymentType(p.categories?.commitment),
        salaryText: salary,
        description: joinNonEmpty([p.descriptionPlain, lists, p.additionalPlain], '\n') ?? '',
        postedAt: toDate(p.createdAt),
      };
    }
  },
};
