import { describe, expect, it } from 'vitest';
import { checkAccess, createSessionToken, requirePasswordForHost, safeNext, verifyPassword, verifySessionToken } from './access';

const env = (over: Record<string, string> = {}) => ({ ...over });
const req = (host: string | null, path = '/', cookie: string | null = null) => ({ host, path, cookie });

describe('checkAccess', () => {
  it('serves loopback hosts on any port (Docker may publish another port)', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'localhost:8080', '[::1]:3000']) expect(checkAccess(req(host), env(), 0).allow).toBe(true);
  });

  it('refuses other hosts (DNS rebinding), unless listed', () => {
    expect(checkAccess(req('evil.example:3000'), env(), 0)).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req(null), env(), 0).allow).toBe(false);
    expect(checkAccess(req('jobs.home.lan:3000'), env({ APP_ALLOWED_HOSTS: 'jobs.home.lan, 192.168.1.20' }), 0).allow).toBe(true);
    expect(checkAccess(req('192.168.1.20:3000'), env({ APP_ALLOWED_HOSTS: 'jobs.home.lan, 192.168.1.20' }), 0).allow).toBe(true);
  });

  it('with APP_PASSWORD, asks to sign in except for the sign-in page and the health check', () => {
    const e = env({ APP_PASSWORD: 'correct horse battery' });
    expect(checkAccess(req('localhost:3000', '/feed'), e, 0)).toMatchObject({ allow: false, redirect: '/signin?next=%2Ffeed' });
    expect(checkAccess(req('localhost:3000', '/api/documents/1'), e, 0)).toMatchObject({ allow: false, status: 401 });
    expect(checkAccess(req('localhost:3000', '/signin'), e, 0).allow).toBe(true);
    expect(checkAccess(req('localhost:3000', '/api/health'), e, 0).allow).toBe(true);
    const token = createSessionToken(e.APP_PASSWORD, 1_000);
    expect(checkAccess(req('localhost:3000', '/feed', token), e, 2_000).allow).toBe(true);
  });
});

describe('sessions and passwords', () => {
  it('signs sessions with the password, so changing it signs everyone out; expired or altered tokens fail', () => {
    const t = createSessionToken('pw-1', 1_000);
    expect(verifySessionToken(t, 'pw-1', 2_000)).toBe(true);
    expect(verifySessionToken(t, 'pw-2', 2_000)).toBe(false);
    expect(verifySessionToken(t, 'pw-1', 1_000 + 31 * 86_400_000)).toBe(false);
    expect(verifySessionToken(`${t}x`, 'pw-1', 2_000)).toBe(false);
    expect(verifySessionToken('v1.9999999999999.abc', 'pw-1', 2_000)).toBe(false);
  });

  it('compares passwords in constant time', () => {
    expect(verifyPassword('secret', 'secret')).toBe(true);
    expect(verifyPassword('secreT', 'secret')).toBe(false);
    expect(verifyPassword('', 'secret')).toBe(false);
  });

  it('requires a password before listening beyond this computer', () => {
    expect(requirePasswordForHost('127.0.0.1', {})).toBeNull();
    expect(requirePasswordForHost('0.0.0.0', {})).toMatch(/APP_PASSWORD/);
    expect(requirePasswordForHost('0.0.0.0', { APP_PASSWORD: 'a long password' })).toBeNull();
    expect(requirePasswordForHost('0.0.0.0', { JOB_SCRAPER_IN_DOCKER: 'true' })).toBeNull(); // Docker publishes on 127.0.0.1 only
  });
});

describe('where sign-in sends you next', () => {
  it('only to a page of this app, never to another site', () => {
    expect(safeNext('/applications/3?tab=ready#top')).toBe('/applications/3?tab=ready#top');
    for (const evil of ['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example/x', 'javascript:alert(1)', '\\\\evil.example', '', 'feed']) expect(safeNext(evil), evil).toBe('/');
  });
});

describe('extra host names need a password (final review, ops minor)', () => {
  it('refuses to start when APP_ALLOWED_HOSTS opens the UI to other names but no password is set, also in Docker', () => {
    expect(requirePasswordForHost('0.0.0.0', { JOB_SCRAPER_IN_DOCKER: 'true', APP_ALLOWED_HOSTS: 'jobs.home.lan' })).toMatch(/APP_PASSWORD/);
    expect(requirePasswordForHost('127.0.0.1', { APP_ALLOWED_HOSTS: 'jobs.home.lan' })).toMatch(/APP_PASSWORD/);
    expect(requirePasswordForHost('0.0.0.0', { JOB_SCRAPER_IN_DOCKER: 'true', APP_ALLOWED_HOSTS: 'jobs.home.lan', APP_PASSWORD: 'long-enough-pw' })).toBeNull();
    expect(requirePasswordForHost('127.0.0.1', {})).toBeNull();
  });
});
