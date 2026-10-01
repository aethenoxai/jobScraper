/**
 * Sign in with ChatGPT (D-26): OpenAI's program that lets open-source, locally hosted apps use the user's ChatGPT
 * plan (developers.openai.com/siwc). OAuth with PKCE and dynamic client registration, a loopback redirect
 * (http://127.0.0.1:<port>/callback), tokens kept in the database like the Gmail/Outlook sign-ins.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerSecret } from '../logging';
import type { SettingsStore } from '../settings';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const AGENT_NAME = 'Job Scraper';
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 2 * 60_000;

const ACCOUNT_KEY = 'ai.chatgpt';
const PENDING_KEY = 'ai.chatgpt.pending';
const HOST_KEY = 'ai.chatgpt.hostId';
const PENDING_TTL_MS = 15 * 60_000;
/** Where the browser goes after signing in: setup or Settings → AI provider. */
export const CHATGPT_RETURN_KEY = 'ai.chatgpt.returnTo';
export const ChatGptReturnSchema = z.enum(['/welcome', '/settings/ai']).nullable();

export class ChatGptSignInError extends Error {
  override name = 'ChatGptSignInError';
}

const PendingSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), clientId: z.string(), at: z.number() }).nullable();
const AccountSchema = z
  .object({
    /** Issued at the first sign-in (never the dynamic registration id). */
    clientId: z.string(),
    email: z.string().nullable(),
    subject: z.string(),
    idToken: z.string(),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    scope: z.string(),
    connectedAt: z.number(),
    needsReconnect: z.boolean().default(false),
  })
  .nullable();
type Account = NonNullable<z.infer<typeof AccountSchema>>;

const b64url = (buf: Buffer) => buf.toString('base64url');
const readAccount = (settings: SettingsStore) => settings.get(ACCOUNT_KEY, AccountSchema, null);

function hostId(settings: SettingsStore): string {
  return settings.update(HOST_KEY, z.string().nullable(), null, (id) => id ?? randomUUID()) as string;
}

/** The address of OpenAI's consent page; remembers state, nonce and PKCE verifier for the callback (15 minutes). */
export function startChatGptSignIn(settings: SettingsStore, redirectUri: string, now: () => Date = () => new Date()): string {
  const account = readAccount(settings);
  const clientId = account?.clientId ?? DYNAMIC_CLIENT;
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  settings.set(PENDING_KEY, { state, nonce, verifier, clientId, at: now().getTime() });
  const url = new URL(AUTHORIZE_URL);
  const params: Record<string, string> = {
    client_id: clientId,
    agent_name_hint: AGENT_NAME,
    ext_agent_host_id: hostId(settings),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
  };
  // A returning user goes straight back to the same account.
  if (account?.idToken) params.id_token_hint = account.idToken;
  if (account?.email) params.login_hint = account.email;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const ClaimsSchema = z.object({ iss: z.string(), aud: z.union([z.string(), z.array(z.string())]), exp: z.number(), nonce: z.string().optional(), sub: z.string(), email: z.string().optional() });

/**
 * Reads the ID token's claims. Its signature isn't verified: it came straight from OpenAI's token endpoint over TLS,
 * which OpenID Connect accepts in place of the signature (Core §3.1.3.7). Issuer, audience, expiry and nonce are checked.
 */
function checkedClaims(idToken: unknown, clientId: string, nonce: string, now: Date): z.infer<typeof ClaimsSchema> {
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    claims = ClaimsSchema.parse(JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')));
  } catch {
    throw new ChatGptSignInError('OpenAI’s answer did not include a readable identity. Try signing in again.');
  }
  if (claims.iss.replace(/\/$/, '') !== CHATGPT_ISSUER) throw new ChatGptSignInError('The sign-in came from an unexpected issuer. Try again.');
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(clientId)) throw new ChatGptSignInError('The sign-in was meant for another client (audience). Try again.');
  if (claims.exp * 1000 <= now.getTime()) throw new ChatGptSignInError('The sign-in has expired. Try again.');
  if (claims.nonce !== nonce) throw new ChatGptSignInError('The sign-in did not match the one Job Scraper started (nonce). Try again.');
  return claims;
}

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

async function postToken(fetchImpl: typeof fetch, body: Record<string, string>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/** The redirect back from OpenAI: checks everything, exchanges the code and keeps the account. */
export async function finishChatGptSignIn(
  settings: SettingsStore,
  query: { code?: string | null; state?: string | null; error?: string | null; client_id?: string | null; scope?: string | null },
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ email: string | null }> {
  const pending = settings.get(PENDING_KEY, PendingSchema, null);
  // A callback without our state (a forged link) must not cancel the real sign-in in progress.
  if (!pending || !query.state || pending.state !== query.state) throw new ChatGptSignInError('This sign-in link has expired or did not start here. Start again from the AI step.');
  settings.set(PENDING_KEY, null); // single use
  if (query.error) throw new ChatGptSignInError(query.error === 'access_denied' ? 'You did not allow Job Scraper to use your ChatGPT plan.' : `ChatGPT did not sign in: ${query.error}`);
  if (now().getTime() - pending.at > PENDING_TTL_MS) throw new ChatGptSignInError('This sign-in link has expired. Start again from the AI step.');
  if (!query.code) throw new ChatGptSignInError('OpenAI did not return an authorization code.');
  const issued = query.client_id && query.client_id !== DYNAMIC_CLIENT ? query.client_id : pending.clientId !== DYNAMIC_CLIENT ? pending.clientId : null;
  if (!issued) throw new ChatGptSignInError('OpenAI did not issue a client id for Job Scraper, so the sign-in cannot finish. Try again.');

  const { ok, data } = await postToken(fetchImpl, { grant_type: 'authorization_code', client_id: issued, code: query.code, code_verifier: pending.verifier, redirect_uri: redirectUri, resource: RESOURCE });
  const tokens = TokenSchema.safeParse(data);
  if (!ok || !tokens.success || !tokens.data.refresh_token || !tokens.data.id_token) throw new ChatGptSignInError(`OpenAI refused the sign-in: ${String(data.error ?? 'no tokens')}${data.error_description ? ` (${String(data.error_description)})` : ''}`);
  registerSecret(tokens.data.access_token);
  registerSecret(tokens.data.refresh_token);
  const claims = checkedClaims(tokens.data.id_token, issued, pending.nonce, now());
  const scope = tokens.data.scope ?? query.scope ?? '';
  if (!scope.split(/\s+/).includes(PLAN_SCOPE)) throw new ChatGptSignInError('ChatGPT did not allow Job Scraper to use your plan. Sign in again and allow it.');
  const earlier = readAccount(settings);
  if (earlier && earlier.subject !== claims.sub) throw new ChatGptSignInError('You signed in with a different ChatGPT account. Disconnect the current one first.');

  const account: Account = {
    clientId: issued,
    email: claims.email ?? null,
    subject: claims.sub,
    idToken: tokens.data.id_token,
    accessToken: tokens.data.access_token,
    refreshToken: tokens.data.refresh_token,
    expiresAt: now().getTime() + (tokens.data.expires_in ?? 3600) * 1000,
    scope,
    connectedAt: now().getTime(),
    needsReconnect: false,
  };
  settings.set(ACCOUNT_KEY, account);
  return { email: account.email };
}

export function chatGptAccount(settings: SettingsStore): { email: string | null; connectedAt: number; needsReconnect: boolean } | null {
  const a = readAccount(settings);
  if (!a) return null;
  registerSecret(a.accessToken);
  registerSecret(a.refreshToken);
  return { email: a.email, connectedAt: a.connectedAt, needsReconnect: a.needsReconnect };
}

export function disconnectChatGpt(settings: SettingsStore): void {
  settings.set(ACCOUNT_KEY, null);
}

const AGAIN = 'Sign in with ChatGPT again (Settings → AI provider)';
/** Answers OpenAI documents as "clear the tokens and sign in again". */
const SIGN_IN_AGAIN = new Set(['invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'invalid_refresh_token', 'token_expired']);
const errorCode = (data: Record<string, unknown>) => {
  const e = data.error as unknown;
  return typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
};

// One refresh at a time per refresh token in this process (on globalThis: Next.js bundles get their own modules).
const holder = globalThis as typeof globalThis & { __jobScraperChatGptRefresh?: Map<string, Promise<string>> };
const inFlight = (holder.__jobScraperChatGptRefresh ??= new Map());

async function refresh(settings: SettingsStore, account: Account, fetchImpl: typeof fetch, now: () => Date): Promise<string> {
  const { ok, data } = await postToken(fetchImpl, { grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
  const tokens = TokenSchema.safeParse(data);
  if (ok && tokens.success) {
    registerSecret(tokens.data.access_token);
    registerSecret(tokens.data.refresh_token);
    const saved = settings.update(ACCOUNT_KEY, AccountSchema, null, (current) =>
      current
        ? {
            ...current,
            accessToken: tokens.data.access_token,
            refreshToken: tokens.data.refresh_token ?? current.refreshToken,
            expiresAt: now().getTime() + (tokens.data.expires_in ?? 3600) * 1000,
            scope: tokens.data.scope ?? current.scope,
            needsReconnect: false,
          }
        : current,
    );
    if (!saved) throw new ChatGptSignInError('Sign in with ChatGPT first (Settings → AI provider).');
    return saved.accessToken;
  }
  const code = errorCode(data);
  if (code && SIGN_IN_AGAIN.has(code)) {
    // The other process may have refreshed with the same token a moment earlier and saved the new ones.
    const latest = readAccount(settings);
    if (latest && latest.refreshToken !== account.refreshToken && !latest.needsReconnect && latest.expiresAt - now().getTime() > REFRESH_MARGIN_MS) return latest.accessToken;
    settings.update(ACCOUNT_KEY, AccountSchema, null, (current) => (current ? { ...current, needsReconnect: true } : current));
    throw new ChatGptSignInError(`${AGAIN}: OpenAI ended the sign-in (${String((data.error_description as string | undefined) ?? code)}).`);
  }
  throw new Error(`ChatGPT token refresh failed: ${code ?? 'unexpected answer'}`);
}

/** A usable access token, refreshed shortly before it runs out. Both processes may refresh; the loser adopts the winner's. */
export async function chatGptAccessToken(settings: SettingsStore, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<string> {
  const account = readAccount(settings);
  if (!account) throw new ChatGptSignInError('Sign in with ChatGPT first (Settings → AI provider).');
  registerSecret(account.accessToken);
  registerSecret(account.refreshToken);
  if (account.needsReconnect) throw new ChatGptSignInError(`${AGAIN}: OpenAI ended the earlier sign-in.`);
  if (account.expiresAt - now().getTime() > REFRESH_MARGIN_MS) return account.accessToken;
  const running = inFlight.get(account.refreshToken);
  if (running) return running;
  const attempt = refresh(settings, account, fetchImpl, now).finally(() => inFlight.delete(account.refreshToken));
  inFlight.set(account.refreshToken, attempt);
  return attempt;
}

/** The models this ChatGPT account may use (empty when they can't be listed). */
export async function chatGptModelIds(settings: SettingsStore, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<string[]> {
  try {
    const token = await chatGptAccessToken(settings, fetchImpl, now);
    const res = await fetchImpl(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = z.object({ data: z.array(z.object({ id: z.string(), visibility: z.string().optional() })) }).safeParse(await res.json());
    return body.success ? body.data.data.filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.id) : [];
  } catch {
    return [];
  }
}

/** Where the browser goes after signing in: the AI step of setup, or Settings → AI provider, with the outcome. */
export function chatGptReturnAddress(origin: string, back: '/welcome' | '/settings/ai', outcome: { chatgpt?: string; error?: string }): string {
  const url = new URL(back, origin);
  if (back === '/welcome') url.searchParams.set('step', 'ai');
  for (const [k, v] of Object.entries(outcome)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

/** The fixed address of OpenAI's API: a plan token never goes anywhere else (e.g. a proxy in OPENAI_BASE_URL). */
export const CHATGPT_API_BASE = RESOURCE;
