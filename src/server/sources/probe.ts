import type { HttpClient } from '../http';
import type { Logger } from '../logging';
import { plural } from '../../lib/format';
import { getAdapter } from './registry';
import { SourceConfigError, validateConfig } from './service';
import { RawListingSchema, SourceError, type SourceHints } from './types';

export interface ProbeDeps {
  http: HttpClient;
  env: Record<string, string | undefined>;
  log: Logger;
  hints: SourceHints;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

/** How long the user waits for "Test" in the web process, and how many listings prove the source works. */
const TIMEOUT_MS = 15_000;
const ENOUGH = 3;

/**
 * Tries a source once, from the web process, so the user finds out before saving (like the AI test, D-24).
 * Page-reading sources are never run here: their browser lives in the worker.
 */
export async function probeSource(adapterId: string, config: unknown, deps: ProbeDeps): Promise<ProbeResult> {
  const adapter = getAdapter(adapterId);
  if (!adapter) return { ok: false, message: `Unknown source type "${adapterId}".` };
  let valid: Record<string, unknown>;
  try {
    valid = validateConfig(adapterId, config);
  } catch (err) {
    return { ok: false, message: err instanceof SourceConfigError ? err.message : 'Check the settings.' };
  }
  const missing = (adapter.requiresEnv ?? []).filter((k) => !deps.env[k]);
  if (missing.length) return { ok: false, message: `Add ${missing.join(' and ')} to your .env file first.` };
  if (adapter.capabilities?.includes('readsWebPages')) {
    return { ok: false, message: 'This source reads pages with the browser, which runs in the worker. Save it and the next scan will report how it went.' };
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let returned = 0;
  let usable = 0;
  try {
    for await (const listing of adapter.fetch({ config: valid, http: deps.http, log: deps.log, signal, hints: deps.hints, knownIds: new Set(), env: deps.env, ai: null })) {
      returned++;
      // A source that answers with listings the scan would throw away isn't working, so count only valid ones.
      if (RawListingSchema.safeParse(listing).success) usable++;
      if (usable >= ENOUGH) break;
    }
  } catch (err) {
    if (signal.aborted) return { ok: false, message: `The source didn’t answer within ${TIMEOUT_MS / 1000} seconds. Save it anyway and the next scan will try again.` };
    return { ok: false, message: SourceError.from(err).message };
  }
  if (usable > 0) return { ok: true, message: `Connected: ${plural(usable, 'job')} found${usable >= ENOUGH ? ' so far' : ''}.` };
  if (returned > 0) return { ok: false, message: `The source answered, but none of its ${plural(returned, 'listing')} could be read. The site may have changed its format.` };
  return { ok: true, message: 'Connected, but the source returned no jobs. Check the settings, or save it and wait for the next scan.' };
}
