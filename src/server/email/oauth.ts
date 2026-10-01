/**
 * Connecting Gmail or Outlook for sending (PRD §24) with OAuth 2.0 (authorization code + PKCE) through a redirect
 * back to this local app. The client id/secret come from .env; the refresh token is kept in the local database
 * and registered as a secret so it never reaches logs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerSecret } from '../logging';
import type { SettingsStore } from '../settings';

export type EmailProvider = 'smtp' | 'gmail' | 'outlook';
export type OAuthProvider = Exclude<EmailProvider, 'smtp'>;
export const OAUTH_PROVIDERS: OAuthProvider[] = ['gmail', 'outlook'];

export const EMAIL_SETTINGS_KEY = 'email';
export const EmailSettingsSchema = z.object({ provider: z.enum(['smtp', 'gmail', 'outlook']) });
export const DEFAULT_EMAIL_SETTINGS: z.infer<typeof EmailSettingsSchema> = { provider: 'smtp' };

export class OAuthError extends Error {
  override name = 'OAuthError';
}

export const PROVIDERS: Record<OAuthProvider, { label: string; authUrl: string; tokenUrl: string; scope: string; clientIdEnv: string; clientSecretEnv: string; secretRequired: boolean; smtp: { host: string; port: number; secure: boolean }; extraAuthParams: Record<string, string> }> = {
  gmail: {
    label: 'Gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email',
    clientIdEnv: 'GMAIL_CLIENT_ID',
    clientSecretEnv: 'GMAIL_CLIENT_SECRET',
    secretRequired: true,
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    // Without prompt=consent Google returns no refresh token when the app was approved before.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  outlook: {
    label: 'Outlook',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // IMAP access lets tracking read replies (Settings → Tracking); sending needs only SMTP.Send.
    scope: 'https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email',
    clientIdEnv: 'OUTLOOK_CLIENT_ID',
    clientSecretEnv: 'OUTLOOK_CLIENT_SECRET',
    secretRequired: false,
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    extraAuthParams: { prompt: 'select_account' },
  },
};

/** What Outlook connections asked for before inbox tracking existed (sending only). */
const LEGACY_OUTLOOK_SCOPE = 'https://outlook.office.com/SMTP.Send offline_access openid email';
const IMAP_SCOPE: Record<OAuthProvider, RegExp> = { gmail: /(?:^|\s)https:\/\/mail\.google\.com\/(?:\s|$)/, outlook: /IMAP\.AccessAsUser\.All/ };

/** Whether the connected account allowed reading the inbox (Gmail's mail scope always does). */
export function canReadInbox(account: ConnectedAccount, provider: OAuthProvider): boolean {
  if (provider === 'gmail') return !account.scope || IMAP_SCOPE.gmail.test(account.scope);
  return IMAP_SCOPE.outlook.test(account.scope ?? LEGACY_OUTLOOK_SCOPE);
}

/** Outlook needs the scope on refresh, and it must not be wider than what was granted. */
function refreshScope(account: ConnectedAccount): string {
  const granted = (account.scope ?? LEGACY_OUTLOOK_SCOPE).split(/\s+/).filter(Boolean);
  return [...new Set([...granted, 'offline_access'])].join(' ');
}

const PENDING_KEY = 'email.oauth.pending';
const PENDING_TTL_MS = 15 * 60_000;
const PendingSchema = z.object({ provider: z.enum(['gmail', 'outlook']), state: z.string(), verifier: z.string(), at: z.number() }).nullable();
const accountKey = (p: OAuthProvider) => `email.oauth.${p}`;
/** needsReconnect: the provider ended the sign-in (revoked, expired); sending waits until the user reconnects. */
/** scope: what the provider granted at connect time (refreshes may not ask for more). Missing on older connections. */
export const AccountSchema = z.object({ email: z.string(), refreshToken: z.string(), connectedAt: z.number(), needsReconnect: z.boolean().optional(), scope: z.string().optional() }).nullable();
export type ConnectedAccount = NonNullable<z.infer<typeof AccountSchema>>;

const b64url = (buf: Buffer) => buf.toString('base64url');
export const challengeFor = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export function clientConfig(provider: OAuthProvider, env: Record<string, string | undefined>): { clientId: string; clientSecret: string | null } {
  const p = PROVIDERS[provider];
  const clientId = env[p.clientIdEnv]?.trim();
  const clientSecret = env[p.clientSecretEnv]?.trim() || null;
  if (!clientId || (p.secretRequired && !clientSecret)) {
    throw new OAuthError(`Add ${[p.clientIdEnv, p.secretRequired ? p.clientSecretEnv : null].filter(Boolean).join(' and ')} to your .env file (see the setup guide) and restart Job Scraper.`);
  }
  registerSecret(clientSecret);
  return { clientId, clientSecret };
}

/** Builds the consent URL and remembers the state and PKCE verifier for the callback (single use, 15 minutes). */
export function startOAuth(settings: SettingsStore, provider: OAuthProvider, env: Record<string, string | undefined>, redirectUri: string, now: () => Date = () => new Date()): string {
  const p = PROVIDERS[provider];
  const { clientId } = clientConfig(provider, env);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  settings.set(PENDING_KEY, { provider, state, verifier, at: now().getTime() });
  const url = new URL(p.authUrl);
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: p.scope, state, code_challenge: challengeFor(verifier), code_challenge_method: 'S256', ...p.extraAuthParams };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string; preferred_username?: string; upn?: string };
    return claims.email ?? claims.preferred_username ?? claims.upn ?? null;
  } catch {
    return null;
  }
}

/** Handles the redirect back: checks the state, exchanges the code (with the PKCE verifier) and stores the account. */
export async function completeOAuth(
  settings: SettingsStore,
  provider: OAuthProvider,
  query: { code?: string | null; state?: string | null; error?: string | null },
  env: Record<string, string | undefined>,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<ConnectedAccount> {
  const pending = settings.get(PENDING_KEY, PendingSchema, null);
  // A callback that doesn't carry our state (e.g. a forged link) must not cancel the real sign-in in progress.
  if (!pending || pending.provider !== provider || !query.state || pending.state !== query.state) throw new OAuthError('This sign-in link has expired or did not start here. Start connecting again from Settings → Email.');
  // Single use: whatever happens next, this start can't be completed twice.
  settings.set(PENDING_KEY, null);
  if (query.error) throw new OAuthError(`${PROVIDERS[provider].label} did not connect: ${query.error}`);
  if (now().getTime() - pending.at > PENDING_TTL_MS) throw new OAuthError('This sign-in link has expired. Start connecting again from Settings → Email.');
  if (!query.code) throw new OAuthError('The provider did not return an authorization code.');

  const p = PROVIDERS[provider];
  const { clientId, clientSecret } = clientConfig(provider, env);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: pending.verifier, scope: p.scope });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetchImpl(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; id_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || data.error) throw new OAuthError(`${p.label} refused the sign-in: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`);
  if (!data.refresh_token) throw new OAuthError(`${p.label} did not grant a refresh token, so Job Scraper can't send later. Remove Job Scraper from your account's connected apps and connect again.`);
  const email = emailFromIdToken(data.id_token);
  if (!email) throw new OAuthError(`${p.label} did not say which address you connected. Make sure the email permission is granted.`);

  registerSecret(data.refresh_token);
  const account: ConnectedAccount = { email, refreshToken: data.refresh_token, connectedAt: now().getTime(), scope: data.scope?.trim() || p.scope };
  settings.set(accountKey(provider), account);
  settings.set(EMAIL_SETTINGS_KEY, { provider });
  return account;
}

export function connectedAccount(settings: SettingsStore, provider: OAuthProvider): ConnectedAccount | null {
  const account = settings.get(accountKey(provider), AccountSchema, null);
  if (account) registerSecret(account.refreshToken);
  return account;
}

export function disconnect(settings: SettingsStore, provider: OAuthProvider): void {
  settings.set(accountKey(provider), null);
  if (settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, DEFAULT_EMAIL_SETTINGS).provider === provider) settings.set(EMAIL_SETTINGS_KEY, { provider: 'smtp' });
}

/**
 * Gets a fresh access token with the stored refresh token. Done here rather than by nodemailer because providers
 * rotate refresh tokens (Microsoft does on every refresh): the new one must be saved or sending stops later.
 */
export async function refreshAccessToken(
  settings: SettingsStore,
  provider: OAuthProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ accessToken: string; expires: number }> {
  const p = PROVIDERS[provider];
  const account = connectedAccount(settings, provider);
  if (!account) throw new OAuthError(`Connect your ${p.label} account in Settings → Email.`);
  const { clientId, clientSecret } = clientConfig(provider, env);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  if (provider === 'outlook') body.set('scope', refreshScope(account));
  const res = await fetchImpl(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (data.error === 'invalid_grant') {
    settings.set(accountKey(provider), { ...account, needsReconnect: true });
    throw new OAuthError(`Reconnect your ${p.label} account in Settings → Email: ${p.label} ended the sign-in (${data.error_description ?? 'expired or revoked'}).`);
  }
  if (!res.ok || !data.access_token) throw new Error(`${p.label} token refresh failed: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`);
  registerSecret(data.access_token);
  if (data.refresh_token && data.refresh_token !== account.refreshToken) {
    registerSecret(data.refresh_token);
    settings.set(accountKey(provider), { ...account, refreshToken: data.refresh_token, needsReconnect: false });
  }
  return { accessToken: data.access_token, expires: now().getTime() + (data.expires_in ?? 3600) * 1000 };
}
