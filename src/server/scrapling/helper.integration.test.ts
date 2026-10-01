/**
 * The real helper with Scrapling's stealth browser (skipped until `pnpm run setup` has installed Scrapling; CI
 * installs it). Proves that pages built by JavaScript are read, and that with the guard proxy on nothing reaches
 * this machine, not even through the browser's loopback shortcut.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractJobPostings } from '../discovery/jsonld';
import { createLogger } from '../logging';
import { isPageFetchError, type ScraplingClient } from './client';
import { createScraplingPages } from './page-fetcher';
import { scraplingPython } from './paths';

const log = createLogger({ level: 'silent' });
const posting = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Night Nurse', hiringOrganization: { name: 'Harbour Hospital' }, description: 'Acute ward, nights.' };
// The job data only exists after the page's script has run.
const page = `<!doctype html><html><head><title>Jobs</title></head><body><h1>Loading…</h1><script>
const s = document.createElement('script'); s.type = 'application/ld+json'; s.textContent = ${JSON.stringify(JSON.stringify(posting))};
document.head.appendChild(s); document.querySelector('h1').textContent = 'Night Nurse';
</script></body></html>`;

let server: Server;
let port: number;
let hits = 0;
const clients: ScraplingClient[] = [];

describe.skipIf(!existsSync(scraplingPython(process.env)))('Scrapling helper (real browser)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise((r) => server.close(r));
  });

  it('reads a page whose job data is added by JavaScript', async () => {
    const { pages, client } = createScraplingPages({ env: { ...process.env, JOB_SCRAPER_ALLOW_PRIVATE_URLS: 'true' }, log });
    clients.push(client);
    const result = await pages.fetchPage(`http://127.0.0.1:${port}/jobs/nurse`, { signal: AbortSignal.timeout(110_000) });
    expect(result.status).toBe(200);
    expect(extractJobPostings(result.html, result.finalUrl)).toEqual([expect.objectContaining({ title: 'Night Nurse', company: 'Harbour Hospital' })]);
    // Closing ends the helper through its stdin, well before the SIGTERM fallback (5 s).
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 120_000);

  it('with the guard on, refuses this machine and no request reaches it', async () => {
    const { client } = createScraplingPages({ env: { ...process.env, JOB_SCRAPER_ALLOW_PRIVATE_URLS: 'false' }, log });
    clients.push(client);
    hits = 0;
    for (const url of [`https://127.0.0.1:${port}/jobs/nurse`, `http://127.0.0.1:${port}/jobs/nurse`, `https://localhost:${port}/jobs/nurse`]) {
      const err = await client.call('fetch_page', { url, timeoutMs: 30_000 }, { timeoutMs: 100_000 }).catch((e: unknown) => e);
      expect(isPageFetchError(err) ? err.code : err).toBe('REFUSED');
    }
    expect(hits).toBe(0);
  }, 300_000);

  it('does not read a page whose certificate is not valid (a tampered connection)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scrapling-cert-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
      const tls = createHttpsServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
      await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
      try {
        // Guard off (allow-private mode) so the local test server is reachable at all; only the certificate is wrong.
        const { pages, client } = createScraplingPages({ env: { ...process.env, JOB_SCRAPER_ALLOW_PRIVATE_URLS: 'true' }, log });
        clients.push(client);
        const err = await pages.fetchPage(`https://127.0.0.1:${(tls.address() as AddressInfo).port}/jobs/nurse`, { signal: AbortSignal.timeout(110_000) }).catch((e: unknown) => e);
        expect(isPageFetchError(err) ? err.code : err).toBe('HTTP_ERROR');
        expect((err as Error).message).toMatch(/CERT/);
      } finally {
        await new Promise((r) => tls.close(r));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
