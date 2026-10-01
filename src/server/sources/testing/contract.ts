import { createHttpClient, type HttpClient, type Lookup } from '../../http';
import { createLogger } from '../../logging';
import { RawListingSchema, type JobSourceAdapter, type RawListing, type SourceHints } from '../types';

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

export async function collect<C>(
  adapter: JobSourceAdapter<C>,
  config: C,
  http: HttpClient,
  extra: { knownIds?: Set<string>; hints?: Partial<SourceHints>; env?: Record<string, string>; registerSource?: (adapterId: string, name: string, config: Record<string, unknown>) => void; lookup?: Lookup } = {},
): Promise<RawListing[]> {
  const out: RawListing[] = [];
  for await (const l of adapter.fetch({
    config,
    http,
    log: createLogger({ level: 'silent' }),
    signal: new AbortController().signal,
    hints: { titles: [], locations: [], keywords: [], ...extra.hints },
    knownIds: extra.knownIds ?? new Set(),
    env: extra.env ?? {},
    ai: null,
    registerSource: extra.registerSource,
    lookup: extra.lookup ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
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
