import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createLogger } from '../logging';
import { createQueue, type Queue } from './index';
import { createRunner, type HandlerRegistration } from './runner';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
let queue: Queue;
beforeEach(() => {
  t = createTempDb();
  queue = createQueue(t.db);
});
afterEach(() => t.cleanup());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const runner = (handlers: Record<string, HandlerRegistration>) =>
  createRunner({ queue, handlers, workerId: 'test', log, pollMs: 10 });

describe('runner', () => {
  it('runs a handler with the payload and completes the task', async () => {
    const seen: unknown[] = [];
    const r = runner({ echo: { handle: async (p) => void seen.push(p) } });
    queue.enqueue('echo', { n: 1 });
    expect(r.tick()).toBe(1);
    await r.idle();
    expect(seen).toEqual([{ n: 1 }]);
    expect(queue.counts().done).toBe(1);
  });

  it('records failures for retry without throwing', async () => {
    const r = runner({ bad: { handle: async () => { throw new Error('nope'); } } });
    queue.enqueue('bad', {});
    r.tick();
    await r.idle();
    expect(queue.counts()).toMatchObject({ pending: 1, done: 0 });
  });

  it('isolates handlers that throw synchronously', async () => {
    const r = runner({ sync: { handle: (() => { throw new Error('sync boom'); }) as never } });
    queue.enqueue('sync', {});
    expect(() => r.tick()).not.toThrow();
    await r.idle();
    expect(queue.counts().pending).toBe(1);
  });

  it('respects per-type concurrency without starving other types', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let i = 0;
    const fastSeen: number[] = [];
    const r = runner({
      slow: { concurrency: 2, handle: () => gates[i++].promise },
      fast: { handle: async (p) => void fastSeen.push(p as number) },
    });
    queue.enqueue('slow', {});
    queue.enqueue('slow', {});
    queue.enqueue('slow', {});
    queue.enqueue('fast', 1);

    expect(r.tick()).toBe(3); // 2 slow + 1 fast
    expect(r.tick()).toBe(0); // slow saturated, fast queue empty
    gates[0].resolve();
    await gates[0].promise;
    await new Promise((res) => setTimeout(res, 0));
    expect(r.tick()).toBe(1); // third slow task
    gates[1].resolve();
    gates[2].resolve();
    await r.idle();
    expect(fastSeen).toEqual([1]);
    expect(queue.counts().done).toBe(4);
  });

  it('stop waits for in-flight work', async () => {
    const gate = deferred();
    let finished = false;
    const r = runner({ slow: { handle: async () => { await gate.promise; finished = true; } } });
    queue.enqueue('slow', {});
    r.start();
    await new Promise((res) => setTimeout(res, 50));
    const stopping = r.stop();
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
  });
});

describe('runner cancellation and resilience', () => {
  it('gives handlers an abort signal and fails tasks that exceed their timeout', async () => {
    let seenSignal: AbortSignal | null = null;
    const r = runner({
      slow: {
        timeoutMs: 30,
        handle: (_p, ctx) => {
          seenSignal = ctx.signal;
          return new Promise<void>(() => {}); // never resolves
        },
      },
    });
    const { id } = queue.enqueue('slow', {}, { maxAttempts: 1 });
    r.tick();
    await r.idle();
    expect(seenSignal!.aborted).toBe(true);
    expect(queue.get(id)).toMatchObject({ status: 'failed' });
    expect(queue.get(id)?.lastError).toMatch(/timed out/i);
  });

  it('stop aborts in-flight tasks, returns them to the queue, and respects a deadline', async () => {
    const r = runner({ hang: { handle: () => new Promise<void>(() => {}) } });
    const { id } = queue.enqueue('hang', {});
    r.tick();
    const started = Date.now();
    await r.stop(100);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(queue.get(id)).toMatchObject({ status: 'pending' });
  });

  it('does not re-run a task whose completion could not be recorded, and never throws unhandled', async () => {
    const failing: Queue = { ...queue, complete: () => { throw new Error('SQLITE_BUSY'); } };
    let runs = 0;
    const r = createRunner({ queue: failing, handlers: { once: { handle: async () => void runs++ } }, workerId: 'w', log, pollMs: 10 });
    queue.enqueue('once', {});
    r.tick();
    await r.idle();
    expect(runs).toBe(1);
    expect(queue.counts().pending).toBe(0);
  });

  it('survives queue.fail throwing', async () => {
    const failing: Queue = { ...queue, fail: () => { throw new Error('disk full'); } };
    const r = createRunner({ queue: failing, handlers: { bad: { handle: async () => { throw new Error('x'); } } }, workerId: 'w', log, pollMs: 10 });
    queue.enqueue('bad', {});
    r.tick();
    await expect(r.idle()).resolves.toBeUndefined();
  });
});
