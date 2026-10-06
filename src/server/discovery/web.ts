import { z } from 'zod';
import type { Ai } from '../ai';
import { isPublicHttpUrl, resolvesToPublicAddress, type HttpClient, type Lookup } from '../http';
import { NEVER_FETCH } from '../jobs/links';
import { htmlToText } from '../jobs/normalize';
import { isPageFetchError, SCRAPLING_MISSING } from '../scrapling/client';
import { SourceError, type JobSourceAdapter, type RawListing, type SourceHints } from '../sources/types';
import { recognizeAtsUrl } from './ats-urls';
import { extractJobPostings } from './jsonld';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

/** Sites whose terms or anti-bot measures rule out automated fetching; their jobs arrive via "Add job by URL". */
export { NEVER_FETCH };
/**
 * Pages are read (and the AI fallback started) until this much of the run has passed, so that with a last page
 * (≤ 90 s) and its AI call (≤ 60 s) a run stays inside the scan's per-source limit (5 min).
 */
const READ_BUDGET_MS = 3.5 * 60_000;
const PAGE_TIMEOUT_MS = 90_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

const ATS_SITES = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'apply.workable.com', 'recruitee.com', 'jobs.smartrecruiters.com'];

/**
 * Every hop of a page fetch must be a public web address (also after DNS), outside the never-fetch list,
 * and allowed by robots.txt — so redirects can't reach the local network or LinkedIn/Indeed.
 */
export function pageGuard(http: HttpClient, signal: AbortSignal, lookup?: Lookup, opts: { robots?: boolean; allowPrivate?: boolean } = {}) {
  return async (url: URL): Promise<boolean> => {
    if (NEVER_FETCH.test(url.hostname)) return false;
    if (!opts.allowPrivate && (!isPublicHttpUrl(url) || !(await resolvesToPublicAddress(url.hostname, lookup)))) return false;
    if (opts.robots !== false && !(await http.allowedByRobots(url.href, signal, pageGuard(http, signal, lookup, { ...opts, robots: false })))) return false;
    return true;
  };
}

export const WebConfigSchema = z.object({
  provider: z.enum(['brave', 'searxng']),
  searxngUrl: z.string().trim().url().nullable().default(null),
  maxQueries: z.coerce.number().int().min(1).max(20).default(6),
  maxPages: z.coerce.number().int().min(0).max(50).default(15),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

/** Search queries from what the user is looking for: ATS boards first (cheap to poll afterwards), then open web. */
export function planQueries(hints: SourceHints, max: number): string[] {
  const titles = hints.titles.slice(0, 3);
  const places = hints.locations.length ? hints.locations.slice(0, 2) : [''];
  const ats = `(${ATS_SITES.map((s) => `site:${s}`).join(' OR ')})`;
  const boards: string[] = [];
  const open: string[] = [];
  for (const title of titles) {
    for (const place of places) {
      const where = place && !/^remote$/i.test(place) ? ` ${place}` : ' remote';
      boards.push(`"${title}"${where} ${ats}`);
      open.push(`"${title}"${where} jobs apply careers -site:linkedin.com -site:indeed.com -site:glassdoor.com`);
    }
  }
  const out: string[] = [];
  for (let i = 0; out.length < max && (i < boards.length || i < open.length); i++) {
    if (boards[i]) out.push(boards[i]);
    if (out.length < max && open[i]) out.push(open[i]);
  }
  return out.slice(0, max);
}

async function search(config: WebConfig, query: string, http: HttpClient, env: Record<string, string | undefined>, signal: AbortSignal): Promise<SearchResult[]> {
  if (config.provider === 'brave') {
    const key = env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new SourceError('SOURCE_CONFIG', 'Add BRAVE_SEARCH_API_KEY to your .env file (free tier at brave.com/search/api) or switch web discovery to SearXNG.');
    const data = await http.getJson<{ web?: { results?: Array<{ url: string; title?: string; description?: string }> } }>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`,
      { signal, headers: { 'X-Subscription-Token': key } },
    );
    return (data.web?.results ?? []).map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.description ?? '' }));
  }
  if (!config.searxngUrl) throw new SourceError('SOURCE_CONFIG', 'Enter the URL of your SearXNG instance (with the JSON format enabled).');
  const base = config.searxngUrl.replace(/\/+$/, '');
  const data = await http.getJson<{ results?: Array<{ url: string; title?: string; content?: string }> }>(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { signal });
  return (data.results ?? []).map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.content ?? '' }));
}

const AiJobSchema = z.object({
  isSingleJobPosting: z.boolean(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
});

/** Fallback for pages without JSON-LD: the model only identifies title/company/location; the text comes from the page. */
export async function aiExtractJob(ai: Ai, text: string, url: string): Promise<RawListing | null> {
  const out = await ai.generateObject({
    task: 'web-job-extract',
    schema: AiJobSchema,
    system: 'You decide whether a web page is a single job posting and, if so, copy its job title, hiring company and location exactly as written. Use null for anything not on the page.',
    prompt: `URL: ${url}\nPage text:\n"""\n${text.slice(0, 12_000)}\n"""`,
    timeoutMs: 60_000,
  });
  const lower = text.toLowerCase();
  // Only keep what literally appears on the page.
  if (!out.isSingleJobPosting || !out.title || !out.company || !lower.includes(out.title.toLowerCase()) || !lower.includes(out.company.toLowerCase())) return null;
  return { sourceJobId: url, sourceUrl: url, applicationUrl: url, title: out.title, company: out.company, location: out.location && lower.includes(out.location.toLowerCase()) ? out.location : null, description: text.slice(0, 50_000) };
}

export const web: JobSourceAdapter<WebConfig> = {
  id: 'web',
  displayName: 'Web discovery',
  description: 'Searches the web for your target roles, adds company job boards it finds as sources, and reads job pages that publish structured job data.',
  homepage: 'https://schema.org/JobPosting',
  terms: 'Reads job pages with a stealth browser (Scrapling) that gets past bot checks. Respects robots.txt and never fetches LinkedIn, Indeed, Glassdoor or Naukri pages.',
  configFields: [
    { key: 'provider', label: 'Search provider (brave or searxng)', placeholder: 'brave' },
    { key: 'searxngUrl', label: 'SearXNG URL (only for searxng)', placeholder: 'http://127.0.0.1:8888', optional: true },
    { key: 'maxQueries', label: 'Searches per run', placeholder: '6', optional: true },
    { key: 'maxPages', label: 'Pages to read per run', placeholder: '15', optional: true },
  ],
  configSchema: WebConfigSchema,
  completeSnapshot: false,
  // Search APIs have monthly quotas (Brave free: 2,000/month): ~4 runs a day × 6 queries fits.
  minIntervalMinutes: 360,
  defaultInstances: [{ name: 'Web discovery', config: { provider: 'brave', searxngUrl: null, maxQueries: 6, maxPages: 15 }, enabled: false }],
  async *fetch({ config, http, signal, hints, env, ai, log, registerSource, knownIds, lookup, pages }) {
    const guard = pageGuard(http, signal, lookup);
    const queries = planQueries(hints, config.maxQueries);
    if (!queries.length) {
      log.info('web discovery skipped: add target job titles to a profile');
      return;
    }
    const seen = new Set<string>();
    let read = 0;
    let helperFailures = 0;
    const deadline = Date.now() + READ_BUDGET_MS;
    for (const q of queries) {
      // The rest of the searches (and their quota) wait for the next run.
      if (Date.now() >= deadline) break;
      let results: SearchResult[];
      try {
        results = await search(config, q, http, env, signal);
      } catch (err) {
        throw SourceError.from(err);
      }
      for (const r of results) {
        let url: URL;
        try {
          url = new URL(r.url);
        } catch {
          continue;
        }
        const key = `${url.origin}${url.pathname}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const board = recognizeAtsUrl(r.url);
        if (board) {
          registerSource?.(board.adapterId, board.name, board.config);
          continue;
        }
        if (NEVER_FETCH.test(url.hostname) || !isPublicHttpUrl(url)) continue;
        // Pages already stored are only confirmed as still listed: re-reading them would turn page noise
        // ("posted 3 days ago", re-extracted titles) into fake updates.
        const known = [...knownIds].filter((id) => id === r.url || id.startsWith(`${r.url}#`));
        if (known.length) {
          for (const id of known) yield { sourceJobId: id, sourceUrl: r.url, title: r.title || 'Job', company: '-', touchOnly: true };
          continue;
        }
        if (read >= config.maxPages) continue;
        // Pages left unread are found again by the next run.
        if (Date.now() >= deadline) continue;
        try {
          if (!(await guard(url))) continue;
          read++;
          if (!pages) throw new SourceError('SOURCE_CONFIG', SCRAPLING_MISSING);
          const page = await pages.fetchPage(r.url, { signal, maxBytes: MAX_PAGE_BYTES, timeoutMs: Math.min(PAGE_TIMEOUT_MS, Math.max(10_000, deadline - Date.now())) });
          const postings = extractJobPostings(page.html, page.finalUrl || r.url);
          if (postings.length) {
            yield* postings;
          } else if (ai?.taskStatus('web-job-extract').configured && Date.now() < deadline) {
            // Not after the budget: the AI call (up to a minute) could push the run past the scan's limit.
            const listing = await aiExtractJob(ai, htmlToText(page.html), page.finalUrl || r.url);
            if (listing) yield listing;
          }
        } catch (err) {
          if (signal.aborted || err instanceof SourceError) throw err;
          if (isPageFetchError(err) && err.code === 'NOT_INSTALLED') throw new SourceError('SOURCE_CONFIG', SCRAPLING_MISSING);
          if (isPageFetchError(err) && err.code === 'HELPER_FAILED' && ++helperFailures >= 2) throw new SourceError('SOURCE_UNAVAILABLE', `Scrapling keeps failing: ${err.message}`);
          log.debug({ url: r.url, code: isPageFetchError(err) ? err.code : undefined, error: (err as Error).message }, 'skipped page');
        }
      }
    }
  },
};
