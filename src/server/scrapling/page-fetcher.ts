import path from 'node:path';
import type { Logger } from '../logging';
import type { SettingsStore } from '../settings';
import type { FetchedPage, PageFetcher } from '../sources/types';
import { createScraplingClient, type ScraplingClient } from './client';
import { helperEnv, HELPER_SCRIPT, scraplingPython } from './paths';
import { statusFromHelper, writeScraplingStatus } from './status';

/** How long the browser may take for one step of a page (Scrapling's minimum while solving Cloudflare). */
const HELPER_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

/** Reads pages through the helper; http links are read over https (the guard proxy only allows https). */
export function createPageFetcher(client: ScraplingClient, opts: { allowPrivate: boolean }): PageFetcher {
  return {
    fetchPage(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES }) {
      const target = new URL(url);
      if (!opts.allowPrivate && target.protocol === 'http:') target.protocol = 'https:';
      return client.call<FetchedPage>('fetch_page', { url: target.href, maxBytes, timeoutMs: HELPER_STEP_TIMEOUT_MS }, { signal, timeoutMs });
    },
  };
}

/** The worker's page reader: one helper process, its status recorded for the System page. */
export function createScraplingPages(opts: { env: Record<string, string | undefined>; log: Logger; root?: string; settings?: SettingsStore }): { pages: PageFetcher; client: ScraplingClient } {
  const root = opts.root ?? process.cwd();
  // JOB_SCRAPER_ALLOW_PRIVATE_URLS=true is only for the E2E suite, which serves fixture pages on localhost.
  const allowPrivate = opts.env.JOB_SCRAPER_ALLOW_PRIVATE_URLS === 'true';
  const client = createScraplingClient({
    python: scraplingPython(opts.env, root),
    script: path.join(root, HELPER_SCRIPT),
    env: helperEnv(opts.env, allowPrivate),
    log: opts.log.child({ component: 'scrapling' }),
    onStatus: opts.settings ? (s) => writeScraplingStatus(opts.settings!, statusFromHelper(s)) : undefined,
  });
  return { pages: createPageFetcher(client, { allowPrivate }), client };
}
