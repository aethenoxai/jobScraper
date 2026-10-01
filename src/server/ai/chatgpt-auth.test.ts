import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { scrubSecrets } from '../logging';
import { createSettings } from '../settings';
import { chatGptAccessToken, chatGptAccount, chatGptModelIds, chatGptReturnAddress, disconnectChatGpt, finishChatGptSignIn, startChatGptSignIn } from './chatgpt-auth';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const REDIRECT = 'http://127.0.0.1:3000/callback';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An ID token as the token endpoint returns it (its signature isn't checked: it came straight from OpenAI over TLS). */
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

let clock = new Date('2026-10-01T10:00:00Z');
const now = () => clock;
type Call = { url: string; body: URLSearchParams };

/** A stand-in for OpenAI's token endpoint: records requests and answers with `reply`. */
function tokenEndpoint(reply: (body: URLSearchParams) => { status?: number; json: Record<string, unknown> }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url: String(url), body });
    const r = reply(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
function tokens(nonce: string, over: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) {
  return {
    access_token: 'at-first-123456',
    refresh_token: 'rt-first-123456',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: SCOPE,
    id_token: idToken({ iss: 'https://auth.openai.com', aud: 'oaiapp_123', exp: clock.getTime() / 1000 + 3600, nonce, sub: 'user-1', email: 'asha@example.com', ...claims }),
    ...over,
  };
}

function begin() {
  const settings = createSettings(t.db);
  const url = new URL(startChatGptSignIn(settings, REDIRECT, now));
  return { settings, url, p: (k: string) => url.searchParams.get(k) };
}

async function signedIn() {
  const { settings, p } = begin();
  const { fetchImpl } = tokenEndpoint(() => ({ json: tokens(p('nonce')!) }));
  await finishChatGptSignIn(settings, { code: 'code-1', state: p('state'), client_id: 'oaiapp_123', scope: SCOPE }, REDIRECT, fetchImpl, now);
  return settings;
}

beforeEach(() => (clock = new Date('2026-10-01T10:00:00Z')));

describe('Sign in with ChatGPT (OpenAI’s program for open-source local apps)', () => {
  it('sends the user to OpenAI with dynamic registration, PKCE and the loopback redirect', () => {
    const { url, p } = begin();
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(p('client_id')).toBe('dynamic_agent_client');
    expect(p('agent_name_hint')).toBe('Job Scraper');
    expect(p('ext_agent_host_id')).toMatch(/^[\w-]{8,}$/);
    expect(p('response_type')).toBe('code');
    expect(p('redirect_uri')).toBe(REDIRECT);
    expect(p('scope')).toBe(SCOPE);
    expect(p('resource')).toBe('https://api.openai.com/v1');
    expect(p('code_challenge_method')).toBe('S256');
    expect(p('state')).toBeTruthy();
    expect(p('nonce')).toBeTruthy();
    const again = new URL(startChatGptSignIn(createSettings(t.db), REDIRECT, now));
    expect(again.searchParams.get('ext_agent_host_id')).toBe(p('ext_agent_host_id')); // stable per install
    expect(again.searchParams.get('state')).not.toBe(p('state'));
  });

  it('exchanges the code with the issued client id and the PKCE verifier, and keeps the account', async () => {
    const { settings, p } = begin();
    const { calls, fetchImpl } = tokenEndpoint(() => ({ json: tokens(p('nonce')!) }));
    expect(await finishChatGptSignIn(settings, { code: 'code-1', state: p('state'), client_id: 'oaiapp_123', scope: SCOPE }, REDIRECT, fetchImpl, now)).toEqual({ email: 'asha@example.com' });
    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token');
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_123', code: 'code-1', redirect_uri: REDIRECT, resource: 'https://api.openai.com/v1' });
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(p('code_challenge'));
    expect(chatGptAccount(settings)).toMatchObject({ email: 'asha@example.com', needsReconnect: false });
    expect(scrubSecrets('at-first-123456 rt-first-123456')).toBe('[REDACTED] [REDACTED]');
  });

  it('refuses callbacks it did not start, expired ones, and a denial', async () => {
    const { settings, p } = begin();
    const { fetchImpl, calls } = tokenEndpoint(() => ({ json: tokens(p('nonce')!) }));
    await expect(finishChatGptSignIn(settings, { code: 'c', state: 'forged', client_id: 'oaiapp_123' }, REDIRECT, fetchImpl, now)).rejects.toThrow(/did not start here/);
    await expect(finishChatGptSignIn(settings, { error: 'access_denied', state: p('state') }, REDIRECT, fetchImpl, now)).rejects.toThrow(/did not allow/i);
    const later = begin();
    clock = new Date(clock.getTime() + 16 * 60_000);
    await expect(finishChatGptSignIn(later.settings, { code: 'c', state: later.p('state'), client_id: 'oaiapp_123' }, REDIRECT, fetchImpl, now)).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
  });

  it('does not exchange the code when OpenAI issued no client id', async () => {
    const { settings, p } = begin();
    const { fetchImpl, calls } = tokenEndpoint(() => ({ json: tokens(p('nonce')!) }));
    await expect(finishChatGptSignIn(settings, { code: 'c', state: p('state'), client_id: 'dynamic_agent_client' }, REDIRECT, fetchImpl, now)).rejects.toThrow(/client id/i);
    expect(calls).toHaveLength(0);
  });

  it('checks the ID token (issuer, audience, nonce, expiry) and that plan usage was granted', async () => {
    for (const [claims, over, problem] of [
      [{ nonce: 'other' }, {}, /nonce|not match/i],
      [{ iss: 'https://evil.example' }, {}, /issuer/i],
      [{ aud: 'oaiapp_other' }, {}, /audience|client/i],
      [{ exp: clock.getTime() / 1000 - 10 }, {}, /expired/i],
      [{}, { scope: 'openid email offline_access' }, /plan/i],
    ] as const) {
      const { settings, p } = begin();
      const { fetchImpl } = tokenEndpoint(() => ({ json: tokens(p('nonce')!, over, claims) }));
      await expect(finishChatGptSignIn(settings, { code: 'c', state: p('state'), client_id: 'oaiapp_123', scope: SCOPE }, REDIRECT, fetchImpl, now)).rejects.toThrow(problem);
      expect(chatGptAccount(settings)).toBeNull();
    }
  });

  it('a later sign-in uses the issued client id and names the account it signed in with', async () => {
    const settings = await signedIn();
    const url = new URL(startChatGptSignIn(settings, REDIRECT, now));
    expect(url.searchParams.get('client_id')).toBe('oaiapp_123');
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect(url.searchParams.get('login_hint')).toBe('asha@example.com');
  });

  it('uses the access token while it is fresh, and refreshes it (all tokens replaced together) shortly before it expires', async () => {
    const settings = await signedIn();
    const refresh = tokenEndpoint(() => ({ json: { access_token: 'at-second-123456', refresh_token: 'rt-second-123456', expires_in: 3600, scope: SCOPE } }));
    expect(await chatGptAccessToken(settings, refresh.fetchImpl, now)).toBe('at-first-123456');
    expect(refresh.calls).toHaveLength(0);
    clock = new Date(clock.getTime() + 59 * 60_000);
    expect(await chatGptAccessToken(settings, refresh.fetchImpl, now)).toBe('at-second-123456');
    expect(Object.fromEntries(refresh.calls[0].body)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_123', refresh_token: 'rt-first-123456', resource: 'https://api.openai.com/v1' });
    clock = new Date(clock.getTime() + 59 * 60_000);
    await chatGptAccessToken(settings, refresh.fetchImpl, now);
    expect(refresh.calls[1].body.get('refresh_token')).toBe('rt-second-123456');
  });

  it('when the worker and the web page refresh at once, the loser uses the winner’s new token', async () => {
    const settings = await signedIn();
    clock = new Date(clock.getTime() + 59 * 60_000);
    const raced = tokenEndpoint(() => {
      // The other process refreshed first and saved its tokens; ours is now spent.
      t.sqlite.prepare("update settings set value = json_set(value, '$.accessToken', 'at-winner-123456', '$.refreshToken', 'rt-winner-123456', '$.expiresAt', ?) where key = 'ai.chatgpt'").run(clock.getTime() + 3600_000);
      return { status: 400, json: { error: 'invalid_grant' } };
    });
    expect(await chatGptAccessToken(settings, raced.fetchImpl, now)).toBe('at-winner-123456');
  });

  it('when OpenAI ended the sign-in, asks to sign in again', async () => {
    const settings = await signedIn();
    clock = new Date(clock.getTime() + 59 * 60_000);
    const ended = tokenEndpoint(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'revoked' } }));
    await expect(chatGptAccessToken(settings, ended.fetchImpl, now)).rejects.toThrow(/sign in with chatgpt again/i);
    expect(chatGptAccount(settings)?.needsReconnect).toBe(true);
  });

  it('disconnecting forgets the tokens', async () => {
    const settings = await signedIn();
    disconnectChatGpt(settings);
    expect(chatGptAccount(settings)).toBeNull();
    await expect(chatGptAccessToken(settings, tokenEndpoint(() => ({ json: {} })).fetchImpl, now)).rejects.toThrow(/sign in with chatgpt/i);
  });

  it('refreshes only once when several calls need a new token at the same moment', async () => {
    const settings = await signedIn();
    clock = new Date(clock.getTime() + 59 * 60_000);
    let resolveReply!: () => void;
    const gate = new Promise<void>((r) => (resolveReply = r));
    const calls: string[] = [];
    const slow = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(String(init?.body));
      await gate;
      return new Response(JSON.stringify({ access_token: 'at-once-123456', refresh_token: 'rt-once-123456', expires_in: 3600, scope: SCOPE }), { status: 200 });
    }) as typeof fetch;
    const both = Promise.all([chatGptAccessToken(settings, slow, now), chatGptAccessToken(settings, slow, now)]);
    resolveReply();
    expect(await both).toEqual(['at-once-123456', 'at-once-123456']);
    expect(calls).toHaveLength(1);
  });

  it('treats every "sign in again" answer OpenAI documents the same way as invalid_grant', async () => {
    for (const error of ['refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'invalid_refresh_token', 'token_expired']) {
      const settings = await signedIn();
      clock = new Date(clock.getTime() + 59 * 60_000);
      await expect(chatGptAccessToken(settings, tokenEndpoint(() => ({ status: 401, json: { error } })).fetchImpl, now)).rejects.toThrow(/sign in with chatgpt again/i);
      expect(chatGptAccount(settings)?.needsReconnect).toBe(true);
      disconnectChatGpt(settings);
      clock = new Date('2026-10-01T10:00:00Z');
    }
  });

  it('a successful refresh clears a "sign in again" flag another process set meanwhile', async () => {
    const settings = await signedIn();
    clock = new Date(clock.getTime() + 59 * 60_000);
    const refresh = tokenEndpoint(() => {
      t.sqlite.prepare("update settings set value = json_set(value, '$.needsReconnect', json('true')) where key = 'ai.chatgpt'").run();
      return { json: { access_token: 'at-new-123456', refresh_token: 'rt-new-123456', expires_in: 3600, scope: SCOPE } };
    });
    expect(await chatGptAccessToken(settings, refresh.fetchImpl, now)).toBe('at-new-123456');
    expect(chatGptAccount(settings)?.needsReconnect).toBe(false);
  });

  it('lists the models this ChatGPT account may use', async () => {
    const settings = await signedIn();
    const seen: Array<{ url: string; auth: string | null }> = [];
    const models = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5', visibility: 'list' }, { id: 'gpt-5-mini', visibility: 'list' }, { id: 'internal-x', visibility: 'hide' }] }), { status: 200 });
    }) as typeof fetch;
    expect(await chatGptModelIds(settings, models, now)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(seen).toEqual([{ url: 'https://api.openai.com/v1/models', auth: 'Bearer at-first-123456' }]);
    expect(await chatGptModelIds(settings, (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch, now)).toEqual([]);
  });

  it('comes back to the AI step of setup (or to the AI settings) with the outcome', () => {
    expect(chatGptReturnAddress('http://127.0.0.1:3000', '/welcome', { chatgpt: 'connected' })).toBe('http://127.0.0.1:3000/welcome?step=ai&chatgpt=connected');
    expect(chatGptReturnAddress('http://127.0.0.1:3000', '/settings/ai', { error: 'No luck' })).toBe('http://127.0.0.1:3000/settings/ai?error=No+luck');
  });
});
