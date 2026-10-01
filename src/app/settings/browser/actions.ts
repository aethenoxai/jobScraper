'use server';

import { revalidatePath } from 'next/cache';
import { BROWSER_SETTINGS_KEY, BrowserSettingsSchema } from '@/server/applications/browser-apply';
import { BROWSER_SIGNIN_TASK, checkSignInUrl } from '@/server/browser/signin';
import { getAppContext } from '@/server/context';

export interface BrowserActionResult {
  ok: boolean;
  message: string;
}

export async function saveBrowserSettingsAction(_prev: BrowserActionResult | null, formData: FormData): Promise<BrowserActionResult> {
  const parsed = BrowserSettingsSchema.safeParse({ visible: formData.get('visible') === 'on', dailyCap: Number(formData.get('dailyCap')) });
  if (!parsed.success) return { ok: false, message: 'The daily limit must be a number from 1 to 200.' };
  getAppContext().settings.set(BROWSER_SETTINGS_KEY, parsed.data);
  revalidatePath('/settings/browser');
  return { ok: true, message: 'Browser settings saved.' };
}

/** Opens a visible browser on the site (on the computer running Job Scraper) so the user can sign in once. */
export async function signInToSiteAction(_prev: BrowserActionResult | null, formData: FormData): Promise<BrowserActionResult> {
  const target = checkSignInUrl(formData.get('url'));
  if (!target.ok) return { ok: false, message: target.message };
  getAppContext().queue.enqueue(BROWSER_SIGNIN_TASK, { url: target.url }, { dedupeKey: `${BROWSER_SIGNIN_TASK}:${target.host}` });
  const site = target.host.replace(/^www\./, '');
  return { ok: true, message: `A browser window opens on the computer running Job Scraper. Sign in there, then close the window. The sign-in is kept for applications on ${site} (other addresses of the same company, like a separate careers site, need their own sign-in).` };
}
