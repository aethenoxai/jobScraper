'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getAppContext } from '@/server/context';
import { createMailer } from '@/server/email/mailer';
import { disconnect, EMAIL_SETTINGS_KEY, OAUTH_PROVIDERS, type OAuthProvider } from '@/server/email/oauth';

export interface EmailActionResult {
  ok: boolean;
  message: string;
}

export async function setEmailProviderAction(formData: FormData): Promise<void> {
  const provider = z.enum(['smtp', 'gmail', 'outlook']).safeParse(formData.get('provider'));
  if (!provider.success) return;
  getAppContext().settings.set(EMAIL_SETTINGS_KEY, { provider: provider.data });
  revalidatePath('/settings/email');
}

export async function disconnectEmailAction(provider: string): Promise<void> {
  if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) return;
  disconnect(getAppContext().settings, provider as OAuthProvider);
  revalidatePath('/settings/email');
}

/** Sends a test email to yourself through the selected provider and reports what happened. */
export async function sendTestEmailAction(): Promise<EmailActionResult> {
  const mailer = createMailer({ env: process.env, settings: getAppContext().settings });
  const status = mailer.status();
  if (!status.ok) return { ok: false, message: status.reason ?? 'Email is not set up.' };
  try {
    const r = await mailer.send({ to: status.from!, subject: 'Job Scraper test email', text: 'This is a test from Job Scraper. Applications you approve can be sent from this account.' });
    return { ok: true, message: `Sent to ${status.from}${r.response ? ` (server said: ${r.response})` : ''}.` };
  } catch (err) {
    return { ok: false, message: `The test email failed: ${(err as Error).message}` };
  }
}
