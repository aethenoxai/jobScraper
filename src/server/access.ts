/**
 * Who may use the web UI (PRD §54). By default only this computer: requests must name a loopback host, which also
 * defeats DNS rebinding (a web page that points its own domain at 127.0.0.1 still sends its own Host header).
 * With APP_PASSWORD set, every page and action also needs a signed session cookie.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'js_session';
export const SESSION_DAYS = 30;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Reachable without signing in: the sign-in page itself and the health check used by Docker and the tests. */
const PUBLIC_PATHS = [/^\/signin(?:\/|$|\?)/, /^\/api\/health$/];

export interface AccessRequest {
  host: string | null;
  path: string;
  cookie: string | null;
}
export type AccessDecision = { allow: true } | { allow: false; status: 401 | 403; redirect?: string; reason: string };

const hostname = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();

/** Whether a request's Host header names this computer (or a host the user allowed). */
export function hostAllowed(host: string | null | undefined, env: Record<string, string | undefined>): boolean {
  const allowed = new Set([...LOOPBACK, ...(env.APP_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  return !!host && allowed.has(hostname(host));
}

export function checkAccess(req: AccessRequest, env: Record<string, string | undefined>, now: number): AccessDecision {
  if (!hostAllowed(req.host, env)) return { allow: false, status: 403, reason: 'This address is not allowed. Open Job Scraper at http://127.0.0.1 (or add the host to APP_ALLOWED_HOSTS).' };
  const password = env.APP_PASSWORD;
  if (!password || PUBLIC_PATHS.some((re) => re.test(req.path))) return { allow: true };
  if (req.cookie && verifySessionToken(req.cookie, password, now)) return { allow: true };
  // Pages go to the sign-in page; API calls and downloads just get 401.
  if (req.path.startsWith('/api/')) return { allow: false, status: 401, reason: 'Sign in first.' };
  return { allow: false, status: 401, redirect: `/signin?next=${encodeURIComponent(req.path)}`, reason: 'Sign in first.' };
}

const sign = (payload: string, password: string) => createHmac('sha256', `job-scraper-session:${password}`).update(payload).digest('base64url');

/** "v1.<expiry ms>.<signature>": signed with the password, so changing APP_PASSWORD signs every browser out. */
export function createSessionToken(password: string, now: number): string {
  const payload = `v1.${now + SESSION_DAYS * 86_400_000}`;
  return `${payload}.${sign(payload, password)}`;
}

export function verifySessionToken(token: string, password: string, now: number): boolean {
  const m = token.match(/^(v1\.(\d{1,16}))\.([\w-]{43})$/);
  if (!m || Number(m[2]) <= now) return false;
  const expected = Buffer.from(sign(m[1], password));
  const given = Buffer.from(m[3]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifyPassword(given: string, password: string): boolean {
  if (!given || !password) return false;
  const a = createHmac('sha256', 'cmp').update(given).digest();
  const b = createHmac('sha256', 'cmp').update(password).digest();
  return timingSafeEqual(a, b);
}

/**
 * Where to go after signing in: a path of this app only. Resolved the way a browser would, so tricks like
 * "/\\evil.example" or "/<tab>/evil.example" (which browsers read as another site) fall back to the home page.
 */
export function safeNext(next: string): string {
  const base = 'http://job-scraper.invalid';
  if (!next.startsWith('/')) return '/';
  try {
    const url = new URL(next, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

/** A reason to refuse starting, when the web server would be reachable from other computers without a password. */
export function requirePasswordForHost(host: string, env: Record<string, string | undefined>): string | null {
  const hasPassword = !!env.APP_PASSWORD && env.APP_PASSWORD.length >= 8;
  // Extra host names mean other devices will open it (also through Docker or a proxy): never without a password.
  if (env.APP_ALLOWED_HOSTS?.trim() && !hasPassword) return 'APP_ALLOWED_HOSTS lets other devices open Job Scraper. Set APP_PASSWORD (8+ characters) in .env too.';
  if (LOOPBACK.has(host.toLowerCase())) return null;
  // In Docker the container listens on 0.0.0.0 but compose publishes the port on 127.0.0.1 only.
  if (env.JOB_SCRAPER_IN_DOCKER === 'true') return null;
  if (hasPassword) return null;
  return `HOST=${host} makes Job Scraper reachable from other computers. Set APP_PASSWORD (8+ characters) in .env, or use HOST=127.0.0.1.`;
}
