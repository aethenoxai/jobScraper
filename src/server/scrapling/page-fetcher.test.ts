import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEVER_FETCH } from '../jobs/links';
import { PageFetchError, type ScraplingClient } from './client';
import { createPageFetcher } from './page-fetcher';
import { helperEnv, HELPER_SCRIPT, scraplingPython } from './paths';

function fakeClient(reply: (params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs: number }> = [];
  const client: ScraplingClient = {
    start: async () => ({ scrapling: '0.4.15', python: '3.12.7' }),
    call: async <T>(method: string, params: Record<string, unknown>, opts: { timeoutMs: number }) => {
      calls.push({ method, params, timeoutMs: opts.timeoutMs });
      return reply(params) as T;
    },
    close: async () => {},
  };
  return { client, calls };
}
const signal = new AbortController().signal;

describe('page fetcher', () => {
  it('reads http links over https and passes the limits on', async () => {
    const { client, calls } = fakeClient((p) => ({ status: 200, finalUrl: p.url, html: '<p>job</p>' }));
    const page = await createPageFetcher(client, { allowPrivate: false }).fetchPage('HTTP://Careers.Example/jobs/1?x=1', { signal, maxBytes: 1000, timeoutMs: 30_000 });
    expect(calls).toEqual([{ method: 'fetch_page', params: { url: 'https://careers.example/jobs/1?x=1', maxBytes: 1000, timeoutMs: 60_000 }, timeoutMs: 30_000 }]);
    expect(page).toEqual({ status: 200, finalUrl: 'https://careers.example/jobs/1?x=1', html: '<p>job</p>' });
  });

  it('keeps http links in allow-private mode (the E2E fixture site has no https)', async () => {
    const { client, calls } = fakeClient((p) => ({ status: 200, finalUrl: p.url, html: '' }));
    await createPageFetcher(client, { allowPrivate: true }).fetchPage('http://127.0.0.1:3199/job', { signal });
    expect(calls[0].params.url).toBe('http://127.0.0.1:3199/job');
    expect(calls[0].timeoutMs).toBe(90_000);
  });

  it('passes helper errors on unchanged', async () => {
    const { client } = fakeClient(() => {
      throw new PageFetchError('BLOCKED', 'bot check');
    });
    await expect(createPageFetcher(client, { allowPrivate: false }).fetchPage('https://x.example/', { signal })).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('helper paths and environment', () => {
  it('uses SCRAPLING_PYTHON, else the project venv', () => {
    expect(scraplingPython({ SCRAPLING_PYTHON: ' /opt/scrapling/bin/python ' }, '/app')).toBe('/opt/scrapling/bin/python');
    expect(scraplingPython({}, '/app')).toBe(path.join('/app', '.scrapling', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'));
    expect(HELPER_SCRIPT).toBe(path.join('python', 'scrapling_helper.py'));
  });

  it('gives the helper only what it needs: no keys or passwords from .env', () => {
    const env = helperEnv({ PATH: '/usr/bin', HOME: '/home/me', OPENAI_API_KEY: 'sk-secret', SMTP_PASSWORD: 'pw', TELEGRAM_BOT_TOKEN: 't', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' }, false);
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/me', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', JOB_SCRAPER_GUARD: 'on', JOB_SCRAPER_NEVER_FETCH: NEVER_FETCH.source });
    expect(Object.values(env)).not.toContain('sk-secret');
    expect(Object.keys(env).some((k) => /KEY|PASSWORD|TOKEN|SECRET/.test(k))).toBe(false);
    expect(helperEnv({}, true).JOB_SCRAPER_GUARD).toBe('off');
  });

  it('hands the never-read list to Python in a form Python accepts', () => {
    // The helper compiles it with re.compile(source, re.I): no JS-only syntax (lookbehind flags, \\p{…}, named groups).
    expect(NEVER_FETCH.source).not.toMatch(/\(\?<|\\p\{|\(\?=/);
    expect(NEVER_FETCH.flags).toBe('i');
  });
});
