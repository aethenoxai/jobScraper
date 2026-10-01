import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { backoffMs, createQueue, PermanentError, RetryLaterError } from './index';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
const now = () => clock;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

describe('queue', () => {
  it('claims a pending task and marks it running', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('echo', { msg: 'hi' });
    const task = q.claim('w1');
    expect(task).toMatchObject({ id, type: 'echo', payload: { msg: 'hi' }, status: 'running', attempts: 1, lockedBy: 'w1' });
    expect(q.claim('w1')).toBeNull();
  });

  it('does not claim tasks scheduled in the future', () => {
    const q = createQueue(t.db, { now });
    q.enqueue('later', {}, { runAt: new Date(clock.getTime() + 60_000) });
    expect(q.claim('w1')).toBeNull();
    advance(60_000);
    expect(q.claim('w1')?.type).toBe('later');
  });

  it('claims in FIFO order and filters by type', () => {
    const q = createQueue(t.db, { now });
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    q.enqueue('a', 3);
    expect(q.claim('w1', ['b'])?.payload).toBe(2);
    expect(q.claim('w1', ['a'])?.payload).toBe(1);
    expect(q.claim('w1', [])).toBeNull();
    expect(q.claim('w1')?.payload).toBe(3);
  });

  it('completes tasks', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('echo', {});
    q.claim('w1');
    q.complete(id);
    expect(q.counts()).toEqual({ pending: 0, running: 0, done: 1, failed: 0 });
  });

  it('retries failed tasks with exponential backoff, then gives up', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('flaky', {}, { maxAttempts: 3 });

    q.claim('w1');
    expect(q.fail(id, new Error('boom 1'))).toBe('retrying');
    expect(q.claim('w1')).toBeNull();
    advance(backoffMs(1));
    expect(q.claim('w1')?.attempts).toBe(2);

    expect(q.fail(id, new Error('boom 2'))).toBe('retrying');
    advance(backoffMs(2));
    expect(q.claim('w1')?.attempts).toBe(3);

    expect(q.fail(id, new Error('boom 3'))).toBe('failed');
    expect(q.counts().failed).toBe(1);
  });

  it('does not retry permanent errors', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('apply', {});
    q.claim('w1');
    expect(q.fail(id, new PermanentError('CAPTCHA_DETECTED'))).toBe('failed');
  });

  it('dedupes by key only while a task is active', () => {
    const q = createQueue(t.db, { now });
    const first = q.enqueue('discovery.scan', {}, { dedupeKey: 'discovery.scan' });
    const second = q.enqueue('discovery.scan', {}, { dedupeKey: 'discovery.scan' });
    expect(second).toEqual({ id: first.id, deduped: true });
    q.claim('w1');
    expect(q.enqueue('discovery.scan', {}, { dedupeKey: 'discovery.scan' }).deduped).toBe(true);
    q.complete(first.id);
    expect(q.enqueue('discovery.scan', {}, { dedupeKey: 'discovery.scan' }).deduped).toBe(false);
  });

  it('recoverStale returns interrupted running tasks to the queue', () => {
    const q = createQueue(t.db, { now });
    q.enqueue('long', {});
    q.claim('crashed-worker');
    advance(10 * 60_000);
    expect(q.recoverStale(5 * 60_000)).toBe(1);
    const again = q.claim('w2');
    expect(again).toMatchObject({ type: 'long', lockedBy: 'w2', attempts: 2 });
  });
});

describe('crash loops', () => {
  it('recoverStale fails a task that was interrupted too many times instead of retrying it forever', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('poison', {}, { maxAttempts: 2 });
    q.claim('w1');
    expect(q.recoverStale(0)).toBe(1);
    q.claim('w2');
    q.recoverStale(0);
    expect(q.counts()).toMatchObject({ pending: 0, running: 0, failed: 1 });
    expect(q.claim('w3')).toBeNull();
    expect(q.get(id)?.lastError).toMatch(/interrupted/i);
  });
});

describe('retry later', () => {
  it('reschedules a task for a given time without using up an attempt', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('x', {}, { maxAttempts: 1 });
    q.claim('w1');
    expect(q.fail(id, new RetryLaterError(3_600_000, 'quiet hours'))).toBe('retrying');
    const task = q.get(id)!;
    expect(task).toMatchObject({ status: 'pending', attempts: 0 });
    expect(task.runAt.getTime()).toBe(now().getTime() + 3_600_000);
  });
});

describe('release', () => {
  it('returns a task without using up one of its attempts', () => {
    const q = createQueue(t.db, { now });
    const { id } = q.enqueue('x', {});
    q.claim('w1');
    q.release(id);
    expect(q.get(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('counts', () => {
  it('can count the tasks of one type', () => {
    const q = createQueue(t.db, { now });
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    q.enqueue('a', 3);
    expect(q.counts('a')).toMatchObject({ pending: 2, running: 0 });
    expect(q.counts().pending).toBe(3);
  });
});

describe('recent', () => {
  it('lists the newest tasks of a type', () => {
    const q = createQueue(t.db, { now });
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    q.enqueue('a', 3);
    expect(q.recent('a', 5).map((x) => x.payload)).toEqual([3, 1]);
  });
});

describe('backoffMs', () => {
  it('doubles from 30s and caps at 1h', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});
