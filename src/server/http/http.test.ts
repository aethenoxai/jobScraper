import { describe, expect, it } from 'vitest';
import { createHttpClient, HttpError, isAllowedByRobots, isPublicHttpUrl, parseRetryAfter, parseRobots, resolvesToPublicAddress } from './index';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, at: Date.now() });
    return handler(String(input), init);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

describe('http client', () => {
  it('sends an identifying user agent and parses JSON', async () => {
    const f = fakeFetch(() => json({ ok: 1 }));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    expect(await http.getJson('https://a.example/x')).toEqual({ ok: 1 });
    expect(new Headers(f.calls[0].init.headers).get('user-agent')).toMatch(/JobScraper/);
  });

  it('retries 429 and 5xx, honouring Retry-After', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? json({}, 429, { 'retry-after': '7' }) : n === 2 ? json({}, 503) : json({ done: true })));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms), minGapMs: 0 });
    expect(await http.getJson('https://a.example/x')).toEqual({ done: true });
    expect(waits[0]).toBe(7000);
    expect(f.calls).toHaveLength(3);
  });

  it('does not retry client errors and reports the status', async () => {
    const f = fakeFetch(() => json({}, 404));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    const err = (await http.getJson('https://a.example/missing').catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(f.calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const f = fakeFetch(() => json({}, 500));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0, retries: 2 });
    await expect(http.getJson('https://a.example/x')).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(3);
  });

  it('rejects bodies larger than the limit', async () => {
    const f = fakeFetch(() => new Response('x'.repeat(2000)));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    await expect(http.getText('https://a.example/big', { maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it('paces requests to the same host', async () => {
    const waits: number[] = [];
    const f = fakeFetch(() => json({}));
    let clock = 0;
    const http = createHttpClient({ fetchImpl: f.impl, sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock, minGapMs: 500 });
    await http.getJson('https://a.example/1');
    await http.getJson('https://a.example/2');
    await http.getJson('https://b.example/1');
    expect(waits).toEqual([500]);
  });

  it('aborts when the caller signal fires', async () => {
    const f = fakeFetch((_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    const ac = new AbortController();
    const p = http.getJson('https://a.example/slow', { signal: ac.signal });
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow();
  });
});

describe('robots.txt', () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/jobs\n\nUser-agent: BadBot\nDisallow: /`;

  it('applies the most specific matching rule for our agent group', () => {
    const rules = parseRobots(robots, 'JobScraper');
    expect(isAllowedByRobots(rules, '/careers/123')).toBe(true);
    expect(isAllowedByRobots(rules, '/private/admin')).toBe(false);
    expect(isAllowedByRobots(rules, '/private/jobs/1')).toBe(true);
  });

  it('client checks robots.txt once per origin and treats a missing file as allow', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? (url.includes('a.example') ? new Response(robots) : new Response('', { status: 404 })) : json({})));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    expect(await http.allowedByRobots('https://a.example/private/x')).toBe(false);
    expect(await http.allowedByRobots('https://a.example/jobs')).toBe(true);
    expect(await http.allowedByRobots('https://b.example/anything')).toBe(true);
    expect(f.calls.filter((c) => c.url.endsWith('robots.txt'))).toHaveLength(2);
  });
});

describe('retry-after and redirects', () => {
  it('parses both Retry-After forms', () => {
    const now = new Date('2026-10-01T10:00:00Z').getTime();
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', now)).toBe(3_600_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
  });

  it('gives up at once, reporting the wait, when a source asks to wait longer than a minute', async () => {
    const waits: number[] = [];
    const f = fakeFetch(() => json({}, 429, { 'retry-after': '3600' }));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms), minGapMs: 0 });
    const err = (await http.getJson('https://a.example/x').catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(f.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('checks every redirect hop with the guard', async () => {
    const f = fakeFetch((url) => (url.includes('start') ? new Response(null, { status: 302, headers: { location: 'http://192.168.1.10/admin' } }) : json({ secret: true })));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    await expect(http.getText('https://a.example/start', { guard: (u) => isPublicHttpUrl(u) })).rejects.toThrow(/blocked/);
    expect(f.calls.map((c) => c.url)).toEqual(['https://a.example/start']);
    const ok = fakeFetch((url) => (url.includes('start') ? new Response(null, { status: 301, headers: { location: '/final' } }) : new Response('done')));
    const http2 = createHttpClient({ fetchImpl: ok.impl, sleep: noSleep, minGapMs: 0 });
    expect((await http2.getText('https://a.example/start', { guard: (u) => isPublicHttpUrl(u) })).text).toBe('done');
  });

  it('stops reading a streamed body that exceeds the limit', async () => {
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(500))); c.close(); } });
    const f = fakeFetch(() => new Response(stream));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0 });
    await expect(http.getText('https://a.example/big', { maxBytes: 1200 })).rejects.toThrow(/too large/);
  });
});

describe('address checks', () => {
  it('blocks private, loopback and IPv4-mapped IPv6 addresses', () => {
    expect(isPublicHttpUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isPublicHttpUrl('http://10.0.0.5/')).toBe(false);
    expect(isPublicHttpUrl('https://example.com/')).toBe(true);
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const lookup = async (host: string) => (host === 'evil.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    expect(await resolvesToPublicAddress('evil.example', lookup)).toBe(false);
    expect(await resolvesToPublicAddress('good.example', lookup)).toBe(true);
  });
});

describe('robots edge cases', () => {
  it('only uses a group written for our exact agent name', () => {
    const rules = parseRobots('User-agent: j\nDisallow: /\n\nUser-agent: *\nAllow: /', 'JobScraper');
    expect(isAllowedByRobots(rules, '/jobs')).toBe(true);
  });
});

describe('robots.txt fetch safety', () => {
  it('never follows a robots.txt redirect into the local network and treats 429 as "not now"', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') && url.includes('evil.example') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/feed/1' } }) : url.includes('busy.example') ? new Response('', { status: 429 }) : json({})));
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, minGapMs: 0, retries: 0 });
    expect(await http.allowedByRobots('https://evil.example/job', undefined, (u) => isPublicHttpUrl(u))).toBe(false);
    expect(f.calls.some((c) => c.url.includes('127.0.0.1'))).toBe(false);
    expect(await http.allowedByRobots('https://busy.example/job')).toBe(false);
  });
});
