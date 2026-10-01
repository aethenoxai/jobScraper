import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, guarded, htmlToText, joinNonEmpty, toDate } from './shared';

interface RecruiteeOffer {
  id: number;
  title: string;
  company_name?: string;
  careers_url: string;
  careers_apply_url?: string;
  location?: string;
  city?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  employment_type_code?: string;
  description?: string;
  requirements?: string;
  published_at?: string;
  salary?: { min?: string | number | null; max?: string | number | null; currency?: string | null; period?: string | null };
}

export const recruitee: JobSourceAdapter<{ company: string }> = {
  id: 'recruitee',
  displayName: 'Recruitee job board',
  description: 'Company career sites hosted on Recruitee (<company>.recruitee.com).',
  homepage: 'https://recruitee.com',
  configFields: [{ key: 'company', label: 'Company subdomain', placeholder: 'bunq', help: 'The name in <company>.recruitee.com' }],
  configSchema: z.object({ company: z.string().trim().regex(/^[a-z0-9-]+$/i) }),
  identityKey: 'company',
  completeSnapshot: true,
  minIntervalMinutes: 60,
  async *fetch({ config, http, signal }) {
    const data = await guarded(() => http.getJson<{ offers: RecruiteeOffer[] }>(`https://${encodeURIComponent(config.company)}.recruitee.com/api/offers/`, { signal }));
    for (const o of data.offers ?? []) {
      const s = o.salary;
      yield {
        sourceJobId: String(o.id),
        sourceUrl: o.careers_url,
        applicationUrl: o.careers_apply_url ?? o.careers_url,
        title: o.title,
        company: o.company_name || config.company,
        location: o.location || joinNonEmpty([o.city, o.country]),
        workMode: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : null,
        employmentType: detectEmploymentType(o.employment_type_code),
        salaryText: s?.min ? `${s.currency ?? ''} ${s.min} - ${s.max ?? s.min} ${s.period ? `per ${s.period}` : ''}`.trim() : null,
        description: joinNonEmpty([o.description && htmlToText(o.description), o.requirements && htmlToText(o.requirements)], '\n') ?? '',
        postedAt: toDate(o.published_at),
      };
    }
  },
};
