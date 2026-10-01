import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplyServer } from '../../../e2e/fixtures/apply-server.mjs';
import { createBrowserEngine, siteKey } from './engine';

const server = createApplyServer();
let base = '';
let dir = '';
beforeAll(async () => {
  base = await server.listen(0);
  dir = mkdtempSync(path.join(tmpdir(), 'js-engine-'));
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('browser engine', () => {
  it('names sites by host, without www', () => {
    expect(siteKey('https://www.example.com/jobs/1')).toBe('example.com');
    expect(siteKey('https://boards.greenhouse.io/acme/jobs/1')).toBe('boards.greenhouse.io');
  });

  it('keeps one browser profile per site and shows a status overlay that never blocks clicks', async () => {
    const engine = createBrowserEngine({ profilesDir: dir, headless: () => true });
    const overlay = await engine.withPage(`${base}/greenhouse/acme/jobs/123`, async (page, show) => {
      await page.goto(`${base}/greenhouse/acme/jobs/123`);
      await show('Filling the form for Backend Engineer at Acme');
      return page.evaluate(() => {
        const host = document.getElementById('job-scraper-overlay');
        return { text: host?.shadowRoot?.textContent ?? '', pointerEvents: host ? getComputedStyle(host).pointerEvents : null };
      });
    });
    expect(overlay).toEqual({ text: expect.stringContaining('Filling the form for Backend Engineer at Acme'), pointerEvents: 'none' });
    expect(existsSync(path.join(dir, siteKey(base)))).toBe(true);
  }, 60_000);

  it("supports page code compiled with kept function names (the worker's tsx adds __name calls)", async () => {
    const engine = createBrowserEngine({ profilesDir: dir, headless: () => true });
    const result = await engine.withPage(`${base}/wizard/job`, async (page) => {
      await page.goto(`${base}/wizard/job`);
      // What esbuild's keepNames turns `const visible = () => …` into inside an evaluated function.
      return page.evaluate('(() => { const visible = __name(() => true, "visible"); return visible(); })()');
    });
    expect(result).toBe(true);
  }, 60_000);

  it('runs one application at a time per site', async () => {
    const engine = createBrowserEngine({ profilesDir: dir, headless: () => true });
    const order: string[] = [];
    const job = (name: string) => engine.withPage(`${base}/lever/acme/abc`, async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 200));
      order.push(`end ${name}`);
    });
    await Promise.all([job('a'), job('b')]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  }, 60_000);

  it('closes the browser when the task is cancelled', async () => {
    const engine = createBrowserEngine({ profilesDir: dir, headless: () => true });
    const ac = new AbortController();
    const run = engine.withPage(`${base}/wizard/job`, async (page) => {
      setTimeout(() => ac.abort(new Error('Task timed out')), 100);
      await page.goto(`${base}/wizard/job`);
      await page.waitForTimeout(10_000);
    }, ac.signal);
    await expect(run).rejects.toThrow();
  }, 60_000);

  it('a host name of dots never escapes the profiles folder', () => {
    for (const u of ['http://../', 'http://./x', 'http://.../']) {
      const key = siteKey(u);
      expect(path.resolve(dir, key).startsWith(dir + path.sep)).toBe(true);
    }
  });

  it('sign-in finishes when the user closes the window (the last page), not only when the browser quits', async () => {
    let ctx: BrowserContext | null = null;
    const engine = createBrowserEngine({
      profilesDir: dir,
      headless: () => true,
      launch: async (d) => (ctx = await chromium.launchPersistentContext(d, { headless: true })),
    });
    const done = engine.openForSignIn(`${base}/login-wall/signin`);
    await expect.poll(() => ctx?.pages()[0]?.url() ?? '', { timeout: 10_000 }).toContain('/login-wall/signin');
    await ctx!.pages()[0].close();
    await expect(Promise.race([done.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still open'), 5_000))])).resolves.toBe('closed');
  }, 60_000);

  it('falls back to a hidden browser when no window can be shown (a server without a display)', async () => {
    const engine = createBrowserEngine({
      profilesDir: dir,
      headless: () => false,
      launch: async (d, headless) => {
        if (!headless) throw new Error('Looks like you launched a headed browser without having a XServer running. Missing X server or $DISPLAY');
        return chromium.launchPersistentContext(d, { headless: true });
      },
    });
    await expect(engine.withPage(`${base}/wizard/job`, async () => 'ran')).resolves.toBe('ran');
  }, 60_000);

  it('checks again inside the site lock before opening the browser', async () => {
    const engine = createBrowserEngine({ profilesDir: dir, headless: () => true });
    const order: string[] = [];
    const slow = engine.withPage(`${base}/lever/acme/abc`, async () => {
      order.push('first runs');
      await new Promise((r) => setTimeout(r, 200));
    });
    const second = engine.withPage(`${base}/lever/acme/abc`, async () => void order.push('second runs'), undefined, () => {
      order.push('second checks');
      throw new Error('not now');
    });
    await expect(second).rejects.toThrow('not now');
    await slow;
    expect(order).toEqual(['first runs', 'second checks']);
  }, 60_000);
});
