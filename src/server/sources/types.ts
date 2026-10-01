import { z } from 'zod';
import type { Ai } from '../ai';
import { HttpError, type HttpClient, type Lookup } from '../http';
import type { Logger } from '../logging';

/** What an adapter yields for each job it finds. Descriptions are plain text (use htmlToText). */
const WebUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links are allowed');

export const RawListingSchema = z.object({
  sourceJobId: z.string().min(1).max(300),
  sourceUrl: WebUrl,
  applicationUrl: WebUrl.nullish(),
  applyEmail: z.string().email().nullish(),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(300),
  location: z.string().trim().max(500).nullish(),
  workMode: z.enum(['remote', 'hybrid', 'onsite']).nullish(),
  employmentType: z.string().nullish(),
  salaryText: z.string().max(300).nullish(),
  /** Plain text. Omit for an already-known listing whose details weren't re-fetched (the stored text is kept). */
  description: z.string().max(200_000).nullish(),
  postedAt: z.date().nullish(),
  expiresAt: z.date().nullish(),
  /** Only confirms that a known listing is still there (e.g. re-found web pages); never creates or changes one. */
  touchOnly: z.boolean().optional(),
});
export type RawListing = z.input<typeof RawListingSchema>;

export type SourceErrorCode = 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFIG' | 'SOURCE_PARSE' | 'SOURCE_BLOCKED' | 'SOURCE_RATE_LIMITED';

export class SourceError extends Error {
  override name = 'SourceError';
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    /** How long the source asked us to wait before trying again. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
  static from(err: unknown): SourceError {
    if (err instanceof SourceError) return err;
    if (err instanceof HttpError && err.status === 429) return new SourceError('SOURCE_RATE_LIMITED', err.message, err.retryAfterMs);
    if (err instanceof HttpError && err.retryAfterMs) return new SourceError('SOURCE_UNAVAILABLE', err.message, err.retryAfterMs);
    if (err instanceof HttpError && err.status === 404) return new SourceError('SOURCE_CONFIG', `${err.message}. Check the board name/URL.`);
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return new SourceError('SOURCE_BLOCKED', err.message);
    return new SourceError('SOURCE_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }
}

export interface SourceHints {
  titles: string[];
  locations: string[];
  keywords: string[];
}

export interface SourceContext<C> {
  config: C;
  http: HttpClient;
  log: Logger;
  signal: AbortSignal;
  /** What the user is looking for (from all active profiles); search-capable sources use it. */
  hints: SourceHints;
  /** Source job ids already stored for this source (lets adapters skip detail fetches and stop paging). */
  knownIds: ReadonlySet<string>;
  env: Record<string, string | undefined>;
  ai: Ai | null;
  /** DNS resolver used to refuse private addresses (injected in tests). */
  lookup?: Lookup;
  /** Lets discovery adapters register newly found company boards as sources. */
  registerSource?: (adapterId: string, name: string, config: Record<string, unknown>) => void;
}

export interface ConfigField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  optional?: boolean;
}

export interface JobSourceAdapter<C = Record<string, unknown>> {
  id: string;
  displayName: string;
  description: string;
  homepage: string;
  /** Short attribution/terms note shown in the UI. */
  terms?: string;
  /** Config field that identifies one board/company (compared case-insensitively to avoid duplicates). */
  identityKey?: string;
  /** Internal adapters (e.g. "manual") are not offered in the "add source" list. */
  hidden?: boolean;
  configFields: ConfigField[];
  configSchema: z.ZodType<C>;
  /** True when every fetch returns the source's complete current listing (absence ⇒ removed). */
  completeSnapshot: boolean;
  /** The source lists one posting several times (e.g. once per country site): its exact repeats become one job. */
  repeatsPostings?: boolean;
  /** The scanner never fetches this source more often than this. */
  minIntervalMinutes: number;
  /** Env vars the adapter needs (e.g. API keys); the source can't run without them. */
  requiresEnv?: string[];
  /** Instances created automatically on first start, so nothing must be configured by hand. */
  defaultInstances?: Array<{ name: string; config: C; enabled: boolean }>;
  fetch(ctx: SourceContext<C>): AsyncIterable<RawListing>;
}
