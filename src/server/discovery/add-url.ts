import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ai } from '../ai';
import type { Db } from '../db';
import { jobListings } from '../db/schema';
import { isPublicHttpUrl, type HttpClient, type Lookup } from '../http';
import type { Ingestor } from '../jobs/ingest';
import { PASTED_URL } from '../jobs/links';
import { htmlToText } from '../jobs/normalize';
import type { Logger } from '../logging';
import { getAdapter } from '../sources/registry';
import type { SettingsStore } from '../settings';
import type { SourceService } from '../sources/service';
import { SourceError, type RawListing } from '../sources/types';
import { recognizeAtsUrl } from './ats-urls';
import { extractJobPostings } from './jsonld';
import { NEVER_FETCH, aiExtractJob, pageGuard } from './web';

export { hasRealLink, PASTED_URL } from '../jobs/links';

/** Queue task that adds a job from a URL in the worker. */
export const ADD_URL_TASK = 'discovery.url';

export class AddJobError extends Error {
  override name = 'AddJobError';
}

export interface AddJobDeps {
  db: Db;
  sources: SourceService;
  ingestor: Ingestor;
  http: HttpClient;
  log: Logger;
  ai: Ai | null;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  lookup?: Lookup;
}

export interface AddJobResult {
  jobIds: number[];
  /** Said to the user when the outcome isn't simply "added" (e.g. the board was added but the job is gone). */
  note?: string;
}

const NOTES_KEY = 'discovery.url.notes';
const NotesSchema = z.array(z.object({ taskId: z.number(), note: z.string() }));

/** Keeps what to tell the user about a finished "add by link" task (the last 20). */
export function rememberAddUrlNote(settings: SettingsStore, taskId: number, note: string): void {
  settings.update(NOTES_KEY, NotesSchema, [], (list) => [{ taskId, note }, ...list.filter((n) => n.taskId !== taskId)].slice(0, 20));
}

export function addUrlNotes(settings: SettingsStore): Map<number, string> {
  return new Map(settings.get(NOTES_KEY, NotesSchema, []).map((n) => [n.taskId, n.note]));
}

export const PASTE_HINT = 'This site cannot be read automatically. Open the job, copy its description and use “Paste a job” instead.';

/** Adds the job at a URL: via the company board's API when it is a known ATS, otherwise from the page's structured data. */
export async function addJobByUrl(rawUrl: string, deps: AddJobDeps): Promise<AddJobResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AddJobError('That does not look like a web address.');
  }
  // JOB_SCRAPER_ALLOW_PRIVATE_URLS=true is only for the E2E suite, which serves fixture pages on localhost.
  const allowPrivate = deps.env.JOB_SCRAPER_ALLOW_PRIVATE_URLS === 'true' && /^https?:$/.test(url.protocol);
  if (!allowPrivate && !isPublicHttpUrl(url)) throw new AddJobError('Only public http(s) job pages can be added.');
  if (NEVER_FETCH.test(url.hostname)) throw new AddJobError(PASTE_HINT);

  const board = recognizeAtsUrl(url.href);
  if (board) {
    const adapter = getAdapter(board.adapterId)!;
    let source;
    try {
      // The user explicitly asked for this board, so it is added even if previously deleted.
      source = deps.sources.findByIdentity(board.adapterId, board.config) ?? deps.sources.create(board.adapterId, board.name, board.config, 'user');
    } catch (err) {
      throw new AddJobError(`That ${adapter.displayName} link could not be used: ${(err as Error).message}`);
    }
    const listings: RawListing[] = [];
    try {
      for await (const l of adapter.fetch({
        config: adapter.configSchema.parse(source.config),
        http: deps.http,
        log: deps.log,
        signal: deps.signal,
        hints: { titles: [], locations: [], keywords: [] },
        knownIds: deps.ingestor.knownIds(source.id),
        env: deps.env,
        ai: deps.ai,
      })) {
        listings.push(l);
      }
    } catch (err) {
      throw new AddJobError(`Could not read the ${adapter.displayName}: ${SourceError.from(err).message}`);
    }
    const result = deps.ingestor.ingestRun(source.id, listings, { completeSnapshot: adapter.completeSnapshot });
    // The pasted link may use another host or form of the board's address (boards. vs job-boards.): the job is
    // recognised by its id in the path, or by the same path.
    const segments = new Set(url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x)));
    const pathOf = (u: string | null) => {
      try {
        return u ? new URL(u).pathname.replace(/\/$/, '') : null;
      } catch {
        return null;
      }
    };
    const matching = deps.db
      .select({ jobId: jobListings.jobId, sourceJobId: jobListings.sourceJobId, sourceUrl: jobListings.sourceUrl, applicationUrl: jobListings.applicationUrl })
      .from(jobListings)
      .where(eq(jobListings.sourceId, source.id))
      .all()
      .filter((l) => segments.has(l.sourceJobId) || [l.sourceUrl, l.applicationUrl].some((u) => pathOf(u) === url.pathname.replace(/\/$/, '')))
      .map((r) => r.jobId);
    const open = deps.db.select({ id: jobListings.id }).from(jobListings).where(and(eq(jobListings.sourceId, source.id), eq(jobListings.status, 'active'))).all().length;
    const note = matching.length ? undefined : `This job isn't listed on ${source.name} any more (it may have closed). The board was added to your sources with its ${open} open jobs.`;
    return { jobIds: [...new Set([...matching, ...result.changedJobIds])], ...(note ? { note } : {}) };
  }

  let page;
  try {
    page = await deps.http.getText(url.href, { signal: deps.signal, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, guard: pageGuard(deps.http, deps.signal, deps.lookup, { robots: false, allowPrivate }) });
  } catch (err) {
    throw new AddJobError(`Could not open the page: ${(err as Error).message}`);
  }
  let postings = extractJobPostings(page.text, page.finalUrl || url.href);
  if (!postings.length && deps.ai?.status().configured) {
    const listing = await aiExtractJob(deps.ai, htmlToText(page.text), page.finalUrl || url.href).catch(() => null);
    if (listing) postings = [listing];
  }
  if (!postings.length) throw new AddJobError('No job details were found on that page. Use “Paste a job” to add it by hand.');
  const manual = deps.sources.ensureManualSource();
  return { jobIds: deps.ingestor.ingestRun(manual.id, postings, { completeSnapshot: false }).changedJobIds };
}

export interface ManualJob {
  title: string;
  company: string;
  location?: string | null;
  url?: string | null;
  description: string;
}

/** Stores a job the user pasted (for sites that can't be read automatically). */
export function addJobManually(job: ManualJob, deps: Pick<AddJobDeps, 'sources' | 'ingestor'>): AddJobResult {
  const title = job.title.trim();
  const company = job.company.trim();
  if (!title || !company || !job.description.trim()) throw new AddJobError('Title, company and description are required.');
  const url = job.url?.trim() && /^https?:\/\//i.test(job.url.trim()) ? job.url.trim() : null;
  const manual = deps.sources.ensureManualSource();
  const listing: RawListing = {
    sourceJobId: url ?? `pasted:${Date.now()}:${title.toLowerCase().replace(/\W+/g, '-').slice(0, 60)}`,
    sourceUrl: url ?? PASTED_URL,
    applicationUrl: url,
    title,
    company,
    location: job.location?.trim() || null,
    description: job.description.trim(),
  };
  const r = deps.ingestor.ingestRun(manual.id, [listing], { completeSnapshot: false });
  if (r.stats.parseErrors) throw new AddJobError('The job could not be saved; check the fields.');
  return { jobIds: r.changedJobIds.length ? r.changedJobIds : [] };
}
