import { z } from 'zod';
import { SourceError, type JobSourceAdapter } from '../types';
import { detectEmploymentType, detectWorkMode, guarded, htmlToText, toDate } from './shared';

interface AdzunaJob {
  id: string;
  title: string;
  description?: string;
  redirect_url: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
  contract_time?: string;
  contract_type?: string;
}

const CURRENCY: Record<string, string> = { gb: 'GBP', us: 'USD', in: 'INR', de: 'EUR', fr: 'EUR', nl: 'EUR', it: 'EUR', es: 'EUR', at: 'EUR', be: 'EUR', ca: 'CAD', au: 'AUD', nz: 'NZD', sg: 'SGD', za: 'ZAR', br: 'BRL', mx: 'MXN', pl: 'PLN', ch: 'CHF' };
const MAX_QUERIES = 3;

export const adzuna: JobSourceAdapter<{ country: string; where?: string }> = {
  id: 'adzuna',
  displayName: 'Adzuna',
  description: 'Job search across many countries (India, UK, US, …), with a free Adzuna developer account.',
  homepage: 'https://developer.adzuna.com',
  configFields: [
    { key: 'country', label: 'Country code', placeholder: 'in', help: 'Two letters: in, gb, us, de, ca, au, …' },
    { key: 'where', label: 'City or region', placeholder: 'Bengaluru', optional: true },
  ],
  configSchema: z.object({ country: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/), where: z.string().trim().optional() }),
  capabilities: ['search'],
  completeSnapshot: false,
  minIntervalMinutes: 120,
  requiresEnv: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
  async *fetch({ config, http, signal, hints, env }) {
    if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) throw new SourceError('SOURCE_CONFIG', 'Add ADZUNA_APP_ID and ADZUNA_APP_KEY to your .env file to use Adzuna.');
    const queries = hints.titles.length ? hints.titles.slice(0, MAX_QUERIES) : [''];
    const where = config.where || hints.locations.find((l) => !/remote/i.test(l)) || '';
    const seen = new Set<string>();
    for (const what of queries) {
      const params = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: '50', 'content-type': 'application/json', sort_by: 'date' });
      if (what) params.set('what', what);
      if (where) params.set('where', where);
      const data = await guarded(() => http.getJson<{ results: AdzunaJob[] }>(`https://api.adzuna.com/v1/api/jobs/${config.country}/search/1?${params.toString().replace(/\+/g, '%20')}`, { signal }));
      for (const j of data.results ?? []) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        const title = htmlToText(j.title);
        const actualSalary = j.salary_min && j.salary_is_predicted !== '1';
        yield {
          sourceJobId: j.id,
          sourceUrl: j.redirect_url,
          applicationUrl: j.redirect_url,
          title,
          company: j.company?.display_name?.trim() || 'Unknown company',
          location: j.location?.display_name ?? null,
          workMode: detectWorkMode(j.location?.display_name, title),
          employmentType: detectEmploymentType(j.contract_time, j.contract_type),
          salaryText: actualSalary ? `${CURRENCY[config.country] ?? ''} ${j.salary_min} - ${j.salary_max ?? j.salary_min} per year`.trim() : null,
          description: j.description ? htmlToText(j.description) : '',
          postedAt: toDate(j.created),
        };
      }
    }
  },
};
