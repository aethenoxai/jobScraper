/** Opens a visible browser on a site so the user can sign in once (PRD §27); the session stays in its profile. */
import { z } from 'zod';
import { NEVER_FETCH } from '../discovery/web';
import { PermanentError } from '../queue';
import type { TaskHandler } from '../queue/runner';
import type { BrowserEngine } from './engine';

export const BROWSER_SIGNIN_TASK = 'browser.signin';
const Payload = z.object({ url: z.string() });

/** A site the user may sign in to: a full http(s) address, never LinkedIn, Indeed or another never-automated site. */
export function checkSignInUrl(raw: unknown): { ok: true; url: string; host: string } | { ok: false; message: string } {
  const url = z.string().trim().url().refine((u) => /^https?:\/\//i.test(u)).safeParse(raw);
  if (!url.success) return { ok: false, message: 'Enter the full web address of the site, e.g. https://jobs.smartrecruiters.com/your-company' };
  const host = new URL(url.data).hostname;
  if (NEVER_FETCH.test(host)) return { ok: false, message: `Job Scraper doesn't automate ${host.replace(/^www\./, '')}, so there's nothing to sign in to here. Apply on that site yourself.` };
  return { ok: true, url: url.data, host };
}

export function createSignInHandler(engine: BrowserEngine): TaskHandler {
  return async (payload, ctx) => {
    const parsed = Payload.safeParse(payload);
    const target = parsed.success ? checkSignInUrl(parsed.data.url) : null;
    if (!target?.ok) throw new PermanentError(target?.message ?? 'Invalid browser.signin payload');
    await engine.openForSignIn(target.url, ctx.signal);
  };
}
