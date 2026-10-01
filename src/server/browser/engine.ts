/**
 * The browser Job Scraper applies with (PRD §46): Chromium with one persistent profile per site under
 * data/browser-profiles (so a site the user signed in to stays signed in), a status overlay on the page so the user
 * can see what is happening, and one application at a time per site.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

/** A site's key: its host name without "www." (also the profile folder name). */
export function siteKey(url: string): string {
  const key = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_');
  // "." and ".." would point outside the profiles folder.
  return /^\.*$/.test(key) ? `_${key.length}` : key;
}

/** Injected into every page: a small panel in the corner that shows the current step and never takes clicks. */
const OVERLAY = `(() => {
  const draw = () => {
    if (!document.body || document.getElementById('job-scraper-overlay')) return;
    const host = document.createElement('div');
    host.id = 'job-scraper-overlay';
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;max-width:360px';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div style="font:13px/1.4 system-ui,sans-serif;background:#111;color:#fff;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:.92"><b>Job Scraper</b><div id="t"></div></div>';
    document.body.appendChild(host);
    let saved = '';
    try { saved = sessionStorage.getItem('__jsOverlay') || ''; } catch {}
    root.getElementById('t').textContent = saved;
  };
  window.__jsOverlay = (text) => {
    try { sessionStorage.setItem('__jsOverlay', text); } catch {}
    draw();
    const t = document.getElementById('job-scraper-overlay')?.shadowRoot?.getElementById('t');
    if (t) t.textContent = text;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw); else draw();
})();`;

export interface BrowserEngine {
  /**
   * Runs `fn` with a page in the site's persistent profile. `show` updates the on-page status panel. Applications
   * to the same site wait for each other (a profile can only be open once).
   */
  withPage<T>(url: string, fn: (page: Page, show: (text: string) => Promise<void>) => Promise<T>, signal?: AbortSignal, before?: () => void): Promise<T>;
  /** Opens a visible browser on the site so the user can sign in once; resolves when they close its window. */
  openForSignIn(url: string, signal?: AbortSignal): Promise<void>;
}

const NO_DISPLAY = /\$DISPLAY|X ?server|headed browser|cannot open display/i;

export function createBrowserEngine(opts: { profilesDir: string; headless: () => boolean; launch?: (dir: string, headless: boolean) => Promise<BrowserContext> }): BrowserEngine {
  const locks = new Map<string, Promise<unknown>>();
  const launch =
    opts.launch ??
    (async (dir: string, headless: boolean) => {
      const { chromium } = await import('playwright');
      // The worker handles Ctrl+C and stop signals itself (finishing or releasing its work); Playwright mustn't exit first.
      return chromium.launchPersistentContext(dir, { headless, viewport: { width: 1280, height: 900 }, acceptDownloads: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    });

  async function serialised<T>(site: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(site) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    locks.set(site, current);
    try {
      return await current;
    } finally {
      if (locks.get(site) === current) locks.delete(site);
    }
  }

  async function open(url: string, headless: boolean, opts2: { fallbackToHidden: boolean }): Promise<BrowserContext> {
    const dir = path.join(opts.profilesDir, siteKey(url));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      return await launch(dir, headless);
    } catch (err) {
      // A machine without a display (a server, Docker) can't show the window: apply with a hidden one instead.
      if (headless || !opts2.fallbackToHidden || !NO_DISPLAY.test(err instanceof Error ? err.message : String(err))) throw err;
      return launch(dir, true);
    }
  }

  return {
    withPage(url, fn, signal, before) {
      return serialised(siteKey(url), async () => {
        signal?.throwIfAborted();
        // Limits are checked again here: another application to this site may have just finished.
        before?.();
        const ctx = await open(url, opts.headless(), { fallbackToHidden: true });
        const onAbort = () => void ctx.close().catch(() => {});
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          // The worker runs under tsx, whose esbuild output calls __name() inside functions we evaluate in the page.
          await ctx.addInitScript('globalThis.__name = globalThis.__name || ((fn) => fn);');
          await ctx.addInitScript(OVERLAY);
          const page = ctx.pages()[0] ?? (await ctx.newPage());
          const show = (text: string) => page.evaluate((t) => (window as unknown as { __jsOverlay?: (t: string) => void }).__jsOverlay?.(t), text).catch(() => {});
          return await fn(page, show);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          await ctx.close().catch(() => {});
        }
      });
    },

    openForSignIn(url, signal) {
      return serialised(siteKey(url), async () => {
        let ctx: BrowserContext;
        try {
          ctx = await open(url, false, { fallbackToHidden: false });
        } catch (err) {
          if (NO_DISPLAY.test(err instanceof Error ? err.message : String(err))) throw new Error('Signing in needs a browser window, and this computer has no display. Run Job Scraper on a computer with a screen to sign in.');
          throw err;
        }
        const closed = new Promise<void>((resolve) => ctx.on('close', () => resolve()));
        // Closing the window closes its last page; on macOS the browser itself keeps running.
        const watch = (p: Page) => p.on('close', () => void (ctx.pages().length === 0 && ctx.close().catch(() => {})));
        ctx.on('page', watch);
        ctx.pages().forEach(watch);
        const timer = setTimeout(() => void ctx.close().catch(() => {}), 15 * 60_000);
        signal?.addEventListener('abort', () => void ctx.close().catch(() => {}), { once: true });
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto(url).catch(() => {});
        await closed;
        clearTimeout(timer);
      });
    },
  };
}
