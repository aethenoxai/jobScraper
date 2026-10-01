import { z } from 'zod';
import type { JobSourceAdapter } from '../types';
import { detectEmploymentType, guarded, htmlToText, joinNonEmpty, toDate } from './shared';

interface SrPosting {
  id: string;
  name: string;
  company?: { name?: string };
  location?: { fullLocation?: string; city?: string; country?: string; remote?: boolean; hybrid?: boolean };
  releasedDate?: string;
  typeOfEmployment?: { label?: string };
}
interface SrDetail extends SrPosting {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

const PAGE = 100;
const MAX_POSTINGS = 500;
/** Details (descriptions) need one request each; fetch at most this many new ones per run. */
const MAX_DETAILS_PER_RUN = 40;

export const smartrecruiters: JobSourceAdapter<{ company: string }> = {
  id: 'smartrecruiters',
  displayName: 'SmartRecruiters job board',
  description: 'Company career sites hosted on SmartRecruiters (careers.smartrecruiters.com/<company>).',
  homepage: 'https://www.smartrecruiters.com',
  configFields: [{ key: 'company', label: 'Company identifier', placeholder: 'BoschGroup', help: 'The name in careers.smartrecruiters.com/<company>' }],
  configSchema: z.object({ company: z.string().trim().regex(/^[a-z0-9_-]+$/i) }),
  // Only a capped number of postings is read per run, so absence does not mean removal.
  identityKey: 'company',
  completeSnapshot: false,
  minIntervalMinutes: 60,
  async *fetch({ config, http, signal, knownIds }) {
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(config.company)}/postings`;
    let details = 0;
    const yielded = new Set<string>();
    for (let offset = 0; offset < MAX_POSTINGS; offset += PAGE) {
      const page = await guarded(() => http.getJson<{ totalFound: number; content: SrPosting[] }>(`${base}?limit=${PAGE}&offset=${offset}`, { signal }));
      for (const p of page.content ?? []) {
        if (yielded.has(p.id)) continue;
        yielded.add(p.id);
        const known = knownIds.has(p.id);
        if (!known && details >= MAX_DETAILS_PER_RUN) continue; // picked up on a later run
        let d: SrDetail = p;
        if (!known) {
          d = await guarded(() => http.getJson<SrDetail>(`${base}/${encodeURIComponent(p.id)}`, { signal }));
          details++;
        }
        const sections = d.jobAd?.sections ?? {};
        const description = known
          ? null
          : joinNonEmpty(['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'].map((k) => sections[k]?.text && htmlToText(sections[k].text!)), '\n') ?? '';
        const url = d.postingUrl ?? `https://jobs.smartrecruiters.com/${config.company}/${p.id}`;
        yield {
          sourceJobId: p.id,
          sourceUrl: url,
          applicationUrl: d.applyUrl ?? url,
          title: p.name,
          company: p.company?.name || config.company,
          location: p.location?.fullLocation ?? joinNonEmpty([p.location?.city, p.location?.country]),
          workMode: p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : null,
          employmentType: detectEmploymentType(p.typeOfEmployment?.label),
          description,
          postedAt: toDate(p.releasedDate),
        };
      }
      if ((page.content?.length ?? 0) < PAGE || offset + PAGE >= (page.totalFound ?? 0)) break;
    }
  },
};
