import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, guarded, htmlToText, joinNonEmpty, toDate } from './shared';

interface WorkableJob {
  shortcode: string;
  title: string;
  url: string;
  application_url?: string;
  employment_type?: string;
  telecommuting?: boolean;
  city?: string;
  state?: string;
  country?: string;
  published_on?: string;
  description?: string;
}

export const workable: JobSourceAdapter<{ account: string }> = {
  id: 'workable',
  displayName: 'Workable job board',
  description: 'Company career boards hosted on Workable (apply.workable.com/<account>).',
  homepage: 'https://www.workable.com',
  configFields: [{ key: 'account', label: 'Account name', placeholder: 'huggingface', help: 'The name in apply.workable.com/<account>' }],
  configSchema: z.object({ account: z.string().trim().regex(/^[a-z0-9_-]+$/i) }),
  identityKey: 'account',
  completeSnapshot: true,
  minIntervalMinutes: 60,
  async *fetch({ config, http, signal }) {
    const data = await guarded(() =>
      http.getJson<{ name?: string; jobs: WorkableJob[] }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(config.account)}?details=true`, { signal }),
    );
    for (const j of data.jobs ?? []) {
      yield {
        sourceJobId: j.shortcode,
        sourceUrl: j.url,
        applicationUrl: j.application_url ?? j.url,
        title: j.title,
        company: data.name || config.account,
        location: joinNonEmpty([j.city, j.state, j.country]),
        workMode: j.telecommuting ? 'remote' : null,
        employmentType: detectEmploymentType(j.employment_type),
        description: j.description ? htmlToText(j.description) : '',
        postedAt: toDate(j.published_on),
      };
    }
  },
};
