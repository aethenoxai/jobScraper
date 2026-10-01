/**
 * Talks to python/scrapling_helper.py: starts it on first use, sends one JSON request per line and matches the
 * replies by id. The helper is stopped after a quiet spell and when the worker stops (closing its stdin, which
 * also takes its browser down if the worker dies).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isNamedError } from '../../lib/format';
import type { Logger } from '../logging';

export type PageFetchCode = 'NOT_INSTALLED' | 'REFUSED' | 'BLOCKED' | 'TIMEOUT' | 'HTTP_ERROR' | 'HELPER_FAILED';
const CODES: ReadonlySet<string> = new Set<PageFetchCode>(['NOT_INSTALLED', 'REFUSED', 'BLOCKED', 'TIMEOUT', 'HTTP_ERROR', 'HELPER_FAILED']);

export class PageFetchError extends Error {
  override name = 'PageFetchError';
  constructor(
    readonly code: PageFetchCode,
    message: string,
  ) {
    super(message);
  }
}

/** By name: Next route bundles get their own copy of this module, so instanceof can fail across them. */
export function isPageFetchError(err: unknown): err is PageFetchError {
  return isNamedError(err, 'PageFetchError') && CODES.has((err as PageFetchError).code);
}

export interface HelperInfo {
  scrapling: string;
  python: string;
}

export type HelperStatus = { ready: true; info: HelperInfo } | { ready: false; code: PageFetchCode; error: string };

export interface ScraplingClientOptions {
  python: string;
  script: string;
  args?: string[];
  env: Record<string, string>;
  log: Logger;
  /** The helper (and its browser) is stopped after this long without calls. */
  idleMs?: number;
  startTimeoutMs?: number;
  onStatus?: (status: HelperStatus) => void;
}

export interface ScraplingClient {
  start(): Promise<HelperInfo>;
  call<T>(method: string, params: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<T>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

export function createScraplingClient(opts: ScraplingClientOptions): ScraplingClient {
  const log = opts.log;
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<HelperInfo> | null = null;
  let exited: Promise<void> = Promise.resolve();
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let idleTimer: NodeJS.Timeout | null = null;

  const report = (status: HelperStatus) => {
    try {
      opts.onStatus?.(status);
    } catch (err) {
      log.warn({ err }, 'could not record the Scrapling status');
    }
  };

  function failAll(err: PageFetchError) {
    for (const [id, p] of pending) {
      pending.delete(id);
      p.cleanup();
      p.reject(err);
    }
  }

  function send(msg: Record<string, unknown>) {
    if (child && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function settle(id: number, fn: (p: Pending) => void) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.cleanup();
    fn(p);
    if (pending.size === 0) scheduleIdle();
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), opts.idleMs ?? DEFAULT_IDLE_MS);
    idleTimer.unref();
  }

  function start(): Promise<HelperInfo> {
    if (ready) return ready;
    ready = new Promise<HelperInfo>((resolve, reject) => {
      let failed = false;
      const fail = (code: PageFetchCode, message: string) => {
        if (failed) return;
        failed = true;
        const err = new PageFetchError(code, message);
        report({ ready: false, code, error: message });
        reject(err);
      };
      if (!existsSync(opts.python)) {
        fail('NOT_INSTALLED', `Scrapling isn't installed (no Python at ${opts.python}): run \`pnpm run setup\`.`);
        return;
      }
      const proc = spawn(opts.python, [opts.script, ...(opts.args ?? [])], { stdio: 'pipe', env: opts.env as NodeJS.ProcessEnv });
      child = proc;
      let started = false;
      const timer = setTimeout(() => {
        fail('HELPER_FAILED', 'The Scrapling helper did not start in time.');
        proc.kill('SIGKILL');
      }, opts.startTimeoutMs ?? 30_000);
      proc.stdin.on('error', () => {}); // a dead helper is handled by 'exit'
      exited = new Promise((done) => proc.once('exit', () => done()));
      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(err.code === 'ENOENT' ? 'NOT_INSTALLED' : 'HELPER_FAILED', `The Scrapling helper could not be started: ${err.message}`);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (child === proc) {
          child = null;
          ready = null;
        }
        if (!started) fail('HELPER_FAILED', `The Scrapling helper stopped while starting (${signal ?? `exit ${code}`}).`);
        failAll(new PageFetchError('HELPER_FAILED', `The Scrapling helper stopped (${signal ?? `exit ${code}`}).`));
      });
      createInterface({ input: proc.stderr }).on('line', (line) => log.debug({ helper: line }, 'scrapling helper'));
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg: { event?: string; id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string }; scrapling?: string; python?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          log.warn('the Scrapling helper wrote a line that is not JSON');
          return;
        }
        if (msg.event === 'ready') {
          started = true;
          clearTimeout(timer);
          const info = { scrapling: String(msg.scrapling), python: String(msg.python) };
          report({ ready: true, info });
          resolve(info);
        } else if (msg.event === 'fatal') {
          started = true;
          clearTimeout(timer);
          const code = msg.error?.code && CODES.has(msg.error.code) ? (msg.error.code as PageFetchCode) : 'HELPER_FAILED';
          fail(code, msg.error?.message ?? 'The Scrapling helper could not start.');
        } else if (typeof msg.id === 'number') {
          settle(msg.id, (p) => {
            if (msg.ok) p.resolve(msg.result);
            else {
              const code = msg.error?.code && CODES.has(msg.error.code) ? (msg.error.code as PageFetchCode) : 'HELPER_FAILED';
              p.reject(new PageFetchError(code, msg.error?.message ?? 'The page could not be read.'));
            }
          });
        }
      });
    });
    // A failed start is retried on the next call.
    ready.catch(() => {
      ready = null;
    });
    return ready;
  }

  async function call<T>(method: string, params: Record<string, unknown>, callOpts: { signal?: AbortSignal; timeoutMs: number }): Promise<T> {
    callOpts.signal?.throwIfAborted();
    if (idleTimer) clearTimeout(idleTimer);
    await start();
    callOpts.signal?.throwIfAborted();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const drop = (err: unknown) =>
        settle(id, (p) => {
          send({ id: nextId++, method: 'cancel', params: { target: id } });
          p.reject(err);
        });
      const timer = setTimeout(() => drop(new PageFetchError('TIMEOUT', `The page didn't load within ${Math.round(callOpts.timeoutMs / 1000)} seconds.`)), callOpts.timeoutMs);
      const onAbort = () => drop(callOpts.signal?.reason ?? new Error('Cancelled'));
      callOpts.signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          callOpts.signal?.removeEventListener('abort', onAbort);
        },
      });
      send({ id, method, params });
    });
  }

  async function close(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const proc = child;
    if (!proc) return;
    failAll(new PageFetchError('HELPER_FAILED', 'The Scrapling helper was stopped.'));
    child = null;
    ready = null;
    const gone = exited;
    proc.stdin.end();
    const waited = (ms: number) => Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (await waited(STOP_GRACE_MS)) return;
    proc.kill('SIGTERM');
    if (await waited(KILL_GRACE_MS)) return;
    proc.kill('SIGKILL');
    await gone;
  }

  return { start, call, close };
}
