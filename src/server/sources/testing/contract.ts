import type { Ai } from '../../ai';
import { createHttpClient, type HttpClient, type Lookup } from '../../http';
import { createLogger } from '../../logging';
import { PageFetchError, type PageFetchCode } from '../../scrapling/client';
import { RawListingSchema, type JobSourceAdapter, type PageFetcher, type RawListing, type SourceHints } from '../types';

/**
 * An HTTP client that answers from fixtures. Keys are substrings of the request URL; the value is the
 * JSON (or string) body. `{ __status: 503 }` makes the response fail with that status.
 */
export function fixtureHttp(routes: Record<string, unknown>, seen: string[] = []): HttpClient {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response('not found', { status: 404 });
    const body = routes[key] as { __status?: number } | string;
    if (typeof body === 'object' && body && '__status' in body) return new Response('error', { status: body.__status });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return createHttpClient({ fetchImpl, sleep: async () => {}, minGapMs: 0, retries: 0 });
}

/**
 * Stands in for Scrapling in tests: pages come from the same fixture routes (through `http`, so `seen` records
 * them), and `{ __pageError: 'BLOCKED' }` makes a page fail with that code.
 */
export function fixturePages(http: HttpClient, routes: Record<string, unknown> = {}): PageFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchPage(url, { signal }) {
      calls.push(url);
      const failing = Object.entries(routes).find(([k, v]) => url.includes(k) && typeof v === 'object' && v !== null && '__pageError' in v);
      if (failing) throw new PageFetchError((failing[1] as { __pageError: PageFetchCode }).__pageError, `fixture ${String((failing[1] as { __pageError: string }).__pageError)}`);
      const page = await http.getText(url, { signal });
      return { html: page.text, finalUrl: page.finalUrl || url, status: 200 };
    },
  };
}

export async function collect<C>(
  adapter: JobSourceAdapter<C>,
  config: C,
  http: HttpClient,
  extra: { knownIds?: Set<string>; hints?: Partial<SourceHints>; env?: Record<string, string>; registerSource?: (adapterId: string, name: string, config: Record<string, unknown>) => void; lookup?: Lookup; pages?: PageFetcher | null; signal?: AbortSignal; ai?: Ai | null } = {},
): Promise<RawListing[]> {
  const out: RawListing[] = [];
  for await (const l of adapter.fetch({
    config,
    http,
    log: createLogger({ level: 'silent' }),
    signal: extra.signal ?? new AbortController().signal,
    hints: { titles: [], locations: [], keywords: [], ...extra.hints },
    knownIds: extra.knownIds ?? new Set(),
    env: extra.env ?? {},
    ai: extra.ai ?? null,
    registerSource: extra.registerSource,
    lookup: extra.lookup ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
    pages: extra.pages === null ? undefined : (extra.pages ?? fixturePages(http)),
  })) {
    out.push(l);
  }
  return out;
}

/** Assertions every adapter must satisfy (PLAN §4.1 adapter contract). Returns the parsed listings. */
export function assertListingsValid(listings: RawListing[]): void {
  const ids = new Set<string>();
  for (const l of listings) {
    const r = RawListingSchema.safeParse(l);
    if (!r.success) throw new Error(`Invalid listing ${l.sourceJobId}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    if (ids.has(l.sourceJobId)) throw new Error(`Duplicate sourceJobId ${l.sourceJobId}`);
    ids.add(l.sourceJobId);
  }
}
