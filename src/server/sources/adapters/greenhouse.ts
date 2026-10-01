import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectWorkMode, guarded, htmlToText, slugSchemaMessage, toDate } from './shared';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  company_name?: string;
  location?: { name?: string };
  content?: string;
  first_published?: string;
  updated_at?: string;
}

export const greenhouse: JobSourceAdapter<{ board: string; companyName?: string }> = {
  id: 'greenhouse',
  displayName: 'Greenhouse job board',
  description: 'Company career boards hosted on Greenhouse (boards.greenhouse.io/<board>).',
  homepage: 'https://www.greenhouse.com',
  configFields: [
    { key: 'board', label: 'Board name', placeholder: 'gitlab', help: slugSchemaMessage },
    { key: 'companyName', label: 'Company name', optional: true },
  ],
  configSchema: z.object({ board: z.string().trim().regex(/^[a-z0-9_-]+$/i, slugSchemaMessage), companyName: z.string().trim().optional() }),
  identityKey: 'board',
  completeSnapshot: true,
  minIntervalMinutes: 30,
  async *fetch({ config, http, signal }) {
    const data = await guarded(() => http.getJson<{ jobs: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(config.board)}/jobs?content=true`, { signal }));
    for (const j of data.jobs ?? []) {
      yield {
        sourceJobId: String(j.id),
        sourceUrl: j.absolute_url,
        applicationUrl: j.absolute_url,
        title: j.title,
        company: config.companyName || j.company_name || config.board,
        location: j.location?.name ?? null,
        workMode: detectWorkMode(j.location?.name, j.title),
        description: j.content ? htmlToText(j.content) : '',
        postedAt: toDate(j.first_published ?? j.updated_at),
      };
    }
  },
};
