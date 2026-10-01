/** Polite HTTP client for job sources: identifies itself, paces requests per host, retries transient errors. */
import { lookup as dnsLookup } from 'node:dns/promises';

export const USER_AGENT = 'JobScraper/1.0 (self-hosted personal job search assistant)';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** Waits longer than this are not slept through: the request fails and the caller schedules a later retry. */
const MAX_INLINE_WAIT_MS = 60_000;
const MAX_REDIRECTS = 5;
const ROBOTS_FAILURE_TTL_MS = 60 * 60_000;

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** True for loopback, private, link-local, unique-local and IPv4-mapped private IPv6 addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateIpv4(ip)) return true;
  if (!ip.includes(':')) return false;
  if (ip === '::1' || ip === '::') return true;
  const mapped = ip.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return isPrivateIpv4(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(ip);
}

/** Only public http(s) addresses may be fetched from user- or search-supplied URLs (no localhost/private networks). */
export function isPublicHttpUrl(input: URL | string): boolean {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0') return false;
  return !isPrivateAddress(host);
}

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Resolves a hostname and rejects it if any of its addresses is private (DNS-based SSRF). */
export async function resolvesToPublicAddress(host: string, lookup: Lookup = defaultLookup): Promise<boolean> {
  if (isPrivateAddress(host)) return false;
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    /** Set when the server asked us to come back later than we are willing to wait inline. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface RequestOpts {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /** Checked for the first URL and every redirect target; false blocks the request. */
  guard?: (url: URL) => boolean | Promise<boolean>;
}

export interface TextResponse {
  text: string;
  contentType: string | null;
  finalUrl: string;
}

export interface HttpClient {
  getJson<T = unknown>(url: string, opts?: RequestOpts): Promise<T>;
  getText(url: string, opts?: RequestOpts): Promise<TextResponse>;
  /** `guard` is applied to the robots.txt request too (so a robots redirect can't reach the local network). */
  allowedByRobots(url: string, signal?: AbortSignal, guard?: RequestOpts['guard']): Promise<boolean>;
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Minimum gap between two requests to the same host. */
  minGapMs?: number;
  retries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RobotsRule {
  allow: boolean;
  path: string;
}

/** Parses robots.txt and returns the rules of the group for exactly `agent` (or `*`). */
export function parseRobots(text: string, agent: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if ((key === 'disallow' || key === 'allow') && value) current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.find((g) => g.agents.includes(a));
  return (specific ?? groups.find((g) => g.agents.includes('*')))?.rules ?? [];
}

export function isAllowedByRobots(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${pattern.endsWith('\\$') ? pattern.slice(0, -2) + '$' : pattern}`);
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

async function readLimited(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new HttpError(`Response from ${new URL(url).host} is too large (${declared} bytes)`, res.status, url);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(`Response from ${new URL(url).host} is too large`, res.status, url);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ua = opts.userAgent ?? USER_AGENT;
  const minGap = opts.minGapMs ?? 1000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const lastRequest = new Map<string, number>();
  const hostQueue = new Map<string, Promise<void>>();
  const robotsCache = new Map<string, { rules: Promise<RobotsRule[]>; expiresAt: number }>();

  /** Serialises requests per host and keeps them at least `minGap` apart. */
  async function paced<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = hostQueue.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    hostQueue.set(host, prev.then(() => mine));
    await prev;
    try {
      const last = lastRequest.get(host);
      if (last !== undefined && minGap > 0) {
        const wait = last + minGap - now();
        if (wait > 0) await sleep(wait);
      }
      lastRequest.set(host, now());
      return await fn();
    } finally {
      release();
    }
  }

  /** One request, following redirects by hand so that every hop can be checked. */
  async function fetchFollowing(startUrl: string, ro: RequestOpts, accept: string): Promise<{ res: Response; url: string }> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      if (ro.guard && !(await ro.guard(new URL(url)))) throw new HttpError(`Request to ${new URL(url).host} was blocked`, null, url);
      const host = new URL(url).host;
      const res = await paced(host, () => {
        ro.signal?.throwIfAborted();
        const timeout = AbortSignal.timeout(ro.timeoutMs ?? opts.timeoutMs ?? 30_000);
        const signal = ro.signal ? AbortSignal.any([ro.signal, timeout]) : timeout;
        return fetchImpl(url, { headers: { 'user-agent': ua, accept, ...ro.headers }, signal, redirect: 'manual' });
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new HttpError(`Too many redirects from ${host}`, res.status, url);
        url = new URL(location, url).href;
        continue;
      }
      return { res, url };
    }
  }

  async function request(url: string, ro: RequestOpts, accept: string): Promise<{ res: Response; body: string; finalUrl: string }> {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      ro.signal?.throwIfAborted();
      let got: { res: Response; url: string };
      try {
        got = await fetchFollowing(url, ro, accept);
      } catch (err) {
        if (err instanceof HttpError || ro.signal?.aborted || attempt >= retries) {
          throw err instanceof HttpError ? err : new HttpError(`Request to ${host} failed: ${(err as Error).message}`, null, url);
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const { res } = got;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
        if (retryAfter !== null && retryAfter > MAX_INLINE_WAIT_MS) {
          throw new HttpError(`${host} asked us to wait ${Math.ceil(retryAfter / 60_000)} min (HTTP ${res.status})`, res.status, url, retryAfter);
        }
        if (attempt >= retries) throw new HttpError(`${host} answered HTTP ${res.status}`, res.status, url, retryAfter);
        await sleep(retryAfter ?? 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new HttpError(`${host} answered HTTP ${res.status}`, res.status, url);
      const body = await readLimited(res, ro.maxBytes ?? DEFAULT_MAX_BYTES, url);
      return { res, body, finalUrl: got.url };
    }
  }

  const client: HttpClient = {
    async getJson<T>(url: string, ro: RequestOpts = {}) {
      const { body } = await request(url, ro, 'application/json');
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new HttpError(`Invalid JSON from ${new URL(url).host}`, 200, url);
      }
    },
    async getText(url, ro = {}) {
      const { res, body, finalUrl } = await request(url, ro, 'text/html,application/xhtml+xml,*/*;q=0.8');
      return { text: body, contentType: res.headers.get('content-type'), finalUrl };
    },
    async allowedByRobots(url, signal, guard) {
      const u = new URL(url);
      const cached = robotsCache.get(u.origin);
      let rules = cached && cached.expiresAt > now() ? cached.rules : undefined;
      if (!rules) {
        let failed = false;
        rules = client
          .getText(`${u.origin}/robots.txt`, { signal, maxBytes: 512 * 1024, timeoutMs: 10_000, guard })
          .then((r) => parseRobots(r.text, 'JobScraper'))
          .catch((err: unknown) => {
            // A missing robots.txt allows everything; a server error means "don't crawl for now" (retried in an hour).
            if (err instanceof HttpError && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 429) return [];
            failed = true;
            return [{ allow: false, path: '/' }];
          });
        const entry = { rules, expiresAt: Number.POSITIVE_INFINITY };
        robotsCache.set(u.origin, entry);
        await rules;
        if (failed) entry.expiresAt = now() + ROBOTS_FAILURE_TTL_MS;
      }
      return isAllowedByRobots(await rules, u.pathname + u.search);
    },
  };
  return client;
}
