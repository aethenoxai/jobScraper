import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { scrubSecrets } from '../logging';
import { createSettings } from '../settings';
import { canReadInbox, challengeFor, completeOAuth, connectedAccount, disconnect, EMAIL_SETTINGS_KEY, EmailSettingsSchema, OAuthError, refreshAccessToken, startOAuth } from './oauth';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const env = { GMAIL_CLIENT_ID: 'gid.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'gsecret', OUTLOOK_CLIENT_ID: 'oid' };
const redirect = 'http://127.0.0.1:3000/api/oauth/gmail/callback';
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

function tokenEndpoint(body: Record<string, unknown>, status = 200) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('OAuth for Gmail and Outlook', () => {
  it('uses PKCE S256 (RFC 7636 test vector)', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('starts consent with state, PKCE and offline access', () => {
    const settings = createSettings(t.db);
    const url = new URL(startOAuth(settings, 'gmail', env, redirect));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(env.GMAIL_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
  });

  it('refuses to start without the client id in .env', () => {
    expect(() => startOAuth(createSettings(t.db), 'outlook', {}, redirect)).toThrow(/OUTLOOK_CLIENT_ID/);
  });

  it('completes the flow: exchanges the code with the verifier, stores the account and selects the provider', async () => {
    const settings = createSettings(t.db);
    const state = new URL(startOAuth(settings, 'gmail', env, redirect)).searchParams.get('state')!;
    const { calls, fetchImpl } = tokenEndpoint({ access_token: 'at', refresh_token: 'refresh-token-123', id_token: idToken('asha@gmail.com'), scope: 'https://mail.google.com/' });
    await completeOAuth(settings, 'gmail', { code: 'the-code', state }, env, redirect, fetchImpl);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].body.get('code_verifier')).toMatch(/^[\w-]{43,}$/);
    expect(calls[0].body.get('client_secret')).toBe('gsecret');
    expect(connectedAccount(settings, 'gmail')).toMatchObject({ email: 'asha@gmail.com' });
    expect(settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, { provider: 'smtp' }).provider).toBe('gmail');
    expect(scrubSecrets('token refresh-token-123 leaked')).not.toContain('refresh-token-123');
    // The state is single-use.
    await expect(completeOAuth(settings, 'gmail', { code: 'again', state }, env, redirect, fetchImpl)).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects a callback with a wrong state, another provider, or an expired start', async () => {
    const settings = createSettings(t.db);
    const { fetchImpl } = tokenEndpoint({ refresh_token: 'r', id_token: idToken('a@b.c') });
    const state = new URL(startOAuth(settings, 'gmail', env, redirect)).searchParams.get('state')!;
    await expect(completeOAuth(settings, 'gmail', { code: 'c', state: 'forged' }, env, redirect, fetchImpl)).rejects.toThrow(/expired or did not start here/);
    await expect(completeOAuth(settings, 'outlook', { code: 'c', state }, env, redirect, fetchImpl)).rejects.toThrow(/expired or did not start here/);
    const later = new URL(startOAuth(settings, 'gmail', env, redirect, () => new Date(2026, 0, 1))).searchParams.get('state')!;
    await expect(completeOAuth(settings, 'gmail', { code: 'c', state: later }, env, redirect, fetchImpl, () => new Date(2026, 0, 1, 0, 30))).rejects.toThrow(/expired/);
  });

  it('explains provider errors and a missing refresh token', async () => {
    const settings = createSettings(t.db);
    const s1 = new URL(startOAuth(settings, 'gmail', env, redirect)).searchParams.get('state')!;
    await expect(completeOAuth(settings, 'gmail', { code: 'c', state: s1 }, env, redirect, tokenEndpoint({ error: 'invalid_grant', error_description: 'Bad Request' }, 400).fetchImpl)).rejects.toThrow(/invalid_grant/);
    const s2 = new URL(startOAuth(settings, 'gmail', env, redirect)).searchParams.get('state')!;
    await expect(completeOAuth(settings, 'gmail', { code: 'c', state: s2 }, env, redirect, tokenEndpoint({ access_token: 'x', id_token: idToken('a@b.c') }).fetchImpl)).rejects.toThrow(/refresh token/i);
  });

  it('disconnects and falls back to SMTP', async () => {
    const settings = createSettings(t.db);
    const state = new URL(startOAuth(settings, 'gmail', env, redirect)).searchParams.get('state')!;
    await completeOAuth(settings, 'gmail', { code: 'c', state }, env, redirect, tokenEndpoint({ refresh_token: 'r', id_token: idToken('a@b.c') }).fetchImpl);
    disconnect(settings, 'gmail');
    expect(connectedAccount(settings, 'gmail')).toBeNull();
    expect(settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, { provider: 'smtp' }).provider).toBe('smtp');
  });

  it('refreshes access tokens itself and keeps a rotated refresh token (Microsoft rotates them)', async () => {
    const settings = createSettings(t.db);
    settings.set('email.oauth.outlook', { email: 'me@outlook.com', refreshToken: 'rt-old', connectedAt: 1 });
    const { calls, fetchImpl } = tokenEndpoint({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-new' });
    const token = await refreshAccessToken(settings, 'outlook', env, fetchImpl, () => new Date(1_000_000));
    expect(token).toEqual({ accessToken: 'at-1', expires: 1_000_000 + 3600_000 });
    expect(calls[0].body.get('grant_type')).toBe('refresh_token');
    expect(calls[0].body.get('refresh_token')).toBe('rt-old');
    expect(calls[0].body.has('client_secret')).toBe(false); // public client
    expect(connectedAccount(settings, 'outlook')?.refreshToken).toBe('rt-new');
    expect(scrubSecrets('rt-new')).not.toContain('rt-new');
  });

  it('when the provider ends the sign-in, marks the account for reconnecting', async () => {
    const settings = createSettings(t.db);
    settings.set('email.oauth.gmail', { email: 'a@gmail.com', refreshToken: 'rt', connectedAt: 1 });
    const { fetchImpl } = tokenEndpoint({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    await expect(refreshAccessToken(settings, 'gmail', env, fetchImpl)).rejects.toThrow(/Reconnect your Gmail account/);
    expect(connectedAccount(settings, 'gmail')?.needsReconnect).toBe(true);
  });

  describe('the scope of a refresh never exceeds what was granted (M8 review I1)', () => {
    const scopes = (calls: Array<{ body: URLSearchParams }>) => new Set((calls[0].body.get('scope') ?? '').split(' '));

    it('an Outlook account connected before inbox tracking (SMTP only) keeps refreshing with its own scope', async () => {
      const settings = createSettings(t.db);
      settings.set('email.oauth.outlook', { email: 'me@outlook.com', refreshToken: 'rt', connectedAt: 1 });
      const { calls, fetchImpl } = tokenEndpoint({ access_token: 'at', expires_in: 3600 });
      await refreshAccessToken(settings, 'outlook', env, fetchImpl);
      expect(scopes(calls)).toContain('https://outlook.office.com/SMTP.Send');
      expect(scopes(calls)).not.toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    });

    it('stores the granted scope when connecting and refreshes with exactly that', async () => {
      const settings = createSettings(t.db);
      const state = new URL(startOAuth(settings, 'outlook', env, 'http://127.0.0.1:3000/api/oauth/outlook/callback')).searchParams.get('state')!;
      const granted = 'https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All';
      await completeOAuth(settings, 'outlook', { code: 'c', state }, env, 'http://127.0.0.1:3000/api/oauth/outlook/callback', tokenEndpoint({ refresh_token: 'rt', id_token: idToken('me@outlook.com'), scope: granted }).fetchImpl);
      expect(connectedAccount(settings, 'outlook')?.scope).toBe(granted);
      const { calls, fetchImpl } = tokenEndpoint({ access_token: 'at', expires_in: 3600 });
      await refreshAccessToken(settings, 'outlook', env, fetchImpl);
      expect(scopes(calls)).toEqual(new Set([...granted.split(' '), 'offline_access']));
    });

    it('knows whether the connected account may read the inbox', () => {
      const settings = createSettings(t.db);
      settings.set('email.oauth.outlook', { email: 'me@outlook.com', refreshToken: 'rt', connectedAt: 1 });
      expect(canReadInbox(connectedAccount(settings, 'outlook')!, 'outlook')).toBe(false);
      settings.set('email.oauth.outlook', { email: 'me@outlook.com', refreshToken: 'rt', connectedAt: 1, scope: 'https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All' });
      expect(canReadInbox(connectedAccount(settings, 'outlook')!, 'outlook')).toBe(true);
      settings.set('email.oauth.gmail', { email: 'a@gmail.com', refreshToken: 'rt', connectedAt: 1 });
      expect(canReadInbox(connectedAccount(settings, 'gmail')!, 'gmail')).toBe(true);
    });
  });
});
