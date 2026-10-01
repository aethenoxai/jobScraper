import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging';
import { createScraplingClient, isPageFetchError, type ScraplingClient, type ScraplingClientOptions } from './client';

const FAKE = path.resolve('src/server/scrapling/testing/fake-helper.mjs');
let dir: string;
let logFile: string;
let clients: ScraplingClient[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scrapling-client-'));
  logFile = path.join(dir, 'fake.log');
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  rmSync(dir, { recursive: true, force: true });
});

function client(over: Partial<ScraplingClientOptions> = {}, env: Record<string, string> = {}): ScraplingClient {
  const c = createScraplingClient({ python: process.execPath, script: FAKE, env: { PATH: process.env.PATH ?? '', FAKE_LOG: logFile, ...env }, log: createLogger({ level: 'silent' }), ...over });
  clients.push(c);
  return c;
}
const fetchPage = (c: ScraplingClient, url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) => c.call<{ html: string }>('fetch_page', { url }, { timeoutMs: 5_000, ...opts });
const received = () => readFileSync(logFile, 'utf8').trim().split('\n');
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const codeOf = (err: unknown) => (isPageFetchError(err) ? err.code : `not a PageFetchError: ${String(err)}`);

describe('scrapling client', () => {
  it('reports the helper versions when it is ready', async () => {
    const onStatus = vi.fn();
    await expect(client({ onStatus }).start()).resolves.toEqual({ scrapling: '0.4.15', python: '3.12.7' });
    expect(onStatus).toHaveBeenCalledWith({ ready: true, info: { scrapling: '0.4.15', python: '3.12.7' } });
  });

  it('matches overlapping replies to their requests', async () => {
    const c = client();
    const [slowFirst, fast] = await Promise.all([fetchPage(c, 'https://a.example/?delay=150'), fetchPage(c, 'https://b.example/')]);
    expect(slowFirst.html).toContain('a.example');
    expect(fast.html).toContain('b.example');
  });

  it('turns helper errors into PageFetchError codes (unknown codes become HELPER_FAILED)', async () => {
    const c = client();
    expect(codeOf(await fetchPage(c, 'https://x.example/blocked').catch((e: unknown) => e))).toBe('BLOCKED');
    expect(codeOf(await fetchPage(c, 'https://x.example/weird').catch((e: unknown) => e))).toBe('HELPER_FAILED');
  });

  it('gives up after the timeout and tells the helper to drop the request', async () => {
    const c = client();
    const err = await fetchPage(c, 'https://x.example/slow', { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('TIMEOUT');
    await until(() => received().some((l) => l.includes('"method":"cancel"')));
  });

  it('rejects at once when the scan is cancelled, and tells the helper', async () => {
    const c = client();
    await c.start();
    const ac = new AbortController();
    const pending = fetchPage(c, 'https://x.example/slow', { signal: ac.signal, timeoutMs: 30_000 });
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => received().some((l) => l.includes('"method":"cancel"')));
  });

  it('fails pending calls when the helper crashes, then starts a new one', async () => {
    const c = client();
    const slow = fetchPage(c, 'https://x.example/slow', { timeoutMs: 30_000 }).catch((e: unknown) => e);
    const crash = fetchPage(c, 'https://x.example/crash').catch((e: unknown) => e);
    expect(codeOf(await crash)).toBe('HELPER_FAILED');
    expect(codeOf(await slow)).toBe('HELPER_FAILED');
    await expect(fetchPage(c, 'https://x.example/ok')).resolves.toMatchObject({ html: '<p>https://x.example/ok</p>' });
    expect(received().filter((l) => l.startsWith('start '))).toHaveLength(2);
  });

  it('says NOT_INSTALLED without starting anything when Python is missing', async () => {
    const onStatus = vi.fn();
    const c = client({ python: path.join(dir, 'no-such-python'), onStatus });
    expect(codeOf(await fetchPage(c, 'https://x.example/').catch((e: unknown) => e))).toBe('NOT_INSTALLED');
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ ready: false, code: 'NOT_INSTALLED' }));
  });

  it('passes on the code of a fatal start (Scrapling not importable)', async () => {
    const onStatus = vi.fn();
    const c = client({ onStatus }, { FAKE_MODE: 'fatal' });
    expect(codeOf(await c.start().catch((e: unknown) => e))).toBe('NOT_INSTALLED');
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ ready: false, code: 'NOT_INSTALLED', error: expect.stringContaining('could not be loaded') }));
  });

  it('gives up on a helper that never says it is ready', async () => {
    const c = client({ startTimeoutMs: 300 }, { FAKE_MODE: 'silent' });
    expect(codeOf(await c.start().catch((e: unknown) => e))).toBe('HELPER_FAILED');
  });

  it('stops an idle helper and starts it again when needed', async () => {
    const c = client({ idleMs: 100 });
    await fetchPage(c, 'https://x.example/one');
    await until(() => received().includes('eof'));
    await fetchPage(c, 'https://x.example/two');
    expect(received().filter((l) => l.startsWith('start '))).toHaveLength(2);
  });

  it('stops a helper that was only started (the check at worker start) once it has been idle', async () => {
    const c = client({ idleMs: 100 });
    await c.start();
    await until(() => received().includes('eof'));
  });

  it('a helper still shutting down after going idle does not fail the next helper’s calls', async () => {
    const c = client({ idleMs: 50 }, { FAKE_EXIT_DELAY: '400' });
    await fetchPage(c, 'https://x.example/one');
    await until(() => received().includes('eof'));
    await expect(fetchPage(c, 'https://x.example/two?delay=700')).resolves.toMatchObject({ html: expect.stringContaining('two') });
  });

  it('close() returns when the helper could not be started at all (Python path is not runnable)', async () => {
    const c = client({ python: dir }); // a folder: spawn fails with EACCES and never exits
    expect(codeOf(await c.start().catch((e: unknown) => e))).toBe('HELPER_FAILED');
    const closed = await Promise.race([c.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 2_000))]);
    expect(closed).toBe('closed');
  });

  it('close() ends the helper through its stdin', async () => {
    const c = client();
    await c.start();
    await c.close();
    expect(received()).toContain('eof');
  });

  it('logs what the helper writes to stderr at debug level', async () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug' });
    vi.spyOn(log, 'debug').mockImplementation(((obj: { helper?: string }) => {
      if (obj?.helper) lines.push(obj.helper);
    }) as never);
    const c = client({ log });
    await c.start();
    await until(() => lines.includes('helper says hello on stderr'));
  });
});
