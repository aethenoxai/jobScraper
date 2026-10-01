import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createQueue } from '../queue';
import { createSettings } from '../settings';
import { createScheduler, DEFAULT_SCHEDULER_STATE, describeInterval, isValidInterval, OnboardingIncompleteError, SCAN_TASK } from './index';

let t: ReturnType<typeof createTempDb>;
let clock: Date;
const now = () => clock;
const MIN = 60_000;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

function make() {
  const settings = createSettings(t.db, { now });
  const queue = createQueue(t.db, { now });
  return { queue, scheduler: createScheduler({ settings, queue, now }) };
}

// Drains pending scans (claim + complete, so the dedupe key is released) and returns how many there were.
function pendingScans(queue: ReturnType<typeof createQueue>) {
  let n = 0;
  for (let task = queue.claim('probe', [SCAN_TASK]); task; task = queue.claim('probe', [SCAN_TASK])) {
    queue.complete(task.id);
    n++;
  }
  return n;
}

beforeEach(() => {
  t = createTempDb();
  clock = new Date('2026-10-01T10:00:00Z');
});
afterEach(() => t.cleanup());

describe('scheduler', () => {
  it('starts disabled with a 60 minute interval (most sources allow at most hourly checks)', () => {
    expect(make().scheduler.getState()).toEqual({ enabled: false, intervalMinutes: 60, lastTriggeredAt: null, nextRunAt: null });
  });

  it('runs immediately on start, then every interval', () => {
    const { scheduler, queue } = make();
    scheduler.start();
    expect(scheduler.tick()).toBe(true);
    expect(scheduler.getState().nextRunAt).toBe(clock.getTime() + DEFAULT_SCHEDULER_STATE.intervalMinutes * MIN);
    expect(scheduler.tick()).toBe(false);
    expect(pendingScans(queue)).toBe(1);
  });

  it('a scan that could not be queued keeps it due: moving the schedule and queueing happen together (M0 deferred minor)', () => {
    const settings = createSettings(t.db, { now });
    const queue = createQueue(t.db, { now });
    let broken = true;
    const flaky = { ...queue, enqueue: (...args: Parameters<typeof queue.enqueue>) => (broken ? (() => { throw new Error('disk I/O error'); })() : queue.enqueue(...args)) };
    const scheduler = createScheduler({ settings, queue: flaky, now });
    scheduler.start();
    expect(() => scheduler.tick()).toThrow(/disk I\/O/);
    expect(scheduler.getState()).toMatchObject({ lastTriggeredAt: null, nextRunAt: clock.getTime() });
    broken = false;
    expect(scheduler.tick()).toBe(true);
    expect(pendingScans(queue)).toBe(1);
  });

  it('does nothing while disabled', () => {
    const { scheduler } = make();
    expect(scheduler.tick()).toBe(false);
  });

  it('stop also cancels scheduled scans that are still waiting, but not manual ones', () => {
    const { scheduler, queue } = make();
    scheduler.start();
    scheduler.tick();
    scheduler.stop();
    expect(queue.counts().pending).toBe(0);
    scheduler.runNow();
    scheduler.stop();
    expect(queue.counts().pending).toBe(1);
  });

  it('stop clears the next run', () => {
    const { scheduler } = make();
    scheduler.start();
    scheduler.stop();
    expect(scheduler.getState()).toMatchObject({ enabled: false, nextRunAt: null });
    expect(scheduler.tick()).toBe(false);
  });

  it('wakes from sleep with a single catch-up scan', () => {
    const { scheduler, queue } = make();
    scheduler.start();
    scheduler.tick();
    pendingScans(queue);
    advance(5 * 60 * MIN); // laptop asleep for 5 hours
    expect(scheduler.tick()).toBe(true);
    expect(scheduler.tick()).toBe(false);
    expect(scheduler.getState().nextRunAt).toBe(clock.getTime() + DEFAULT_SCHEDULER_STATE.intervalMinutes * MIN);
    expect(pendingScans(queue)).toBe(1);
  });

  it('changing the interval reschedules from the last trigger, never into the past', () => {
    const { scheduler } = make();
    scheduler.start();
    scheduler.tick();
    const triggered = clock.getTime();
    scheduler.setIntervalMinutes(60);
    expect(scheduler.getState().nextRunAt).toBe(triggered + 60 * MIN);
    advance(90 * MIN);
    scheduler.setIntervalMinutes(15);
    expect(scheduler.getState().nextRunAt).toBe(clock.getTime());
  });

  it('rejects intervals outside 5–1440 minutes', () => {
    const { scheduler } = make();
    expect(() => scheduler.setIntervalMinutes(4)).toThrow(RangeError);
    expect(() => scheduler.setIntervalMinutes(1441)).toThrow(RangeError);
    expect(() => scheduler.setIntervalMinutes(7.5)).toThrow(RangeError);
  });

  it('runNow works while disabled, does not move the schedule, and is deduped', () => {
    const { scheduler } = make();
    const first = scheduler.runNow();
    expect(first.deduped).toBe(false);
    expect(scheduler.runNow()).toEqual({ id: first.id, deduped: true });
    expect(scheduler.getState()).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('a stop issued by another process is respected by tick', () => {
    const web = make().scheduler;
    const worker = make().scheduler;
    web.start();
    web.stop();
    expect(worker.tick()).toBe(false);
    expect(worker.getState().enabled).toBe(false);
  });
});

describe('interval helpers', () => {
  it('validates and describes intervals', () => {
    expect(isValidInterval(5)).toBe(true);
    expect(isValidInterval(1440)).toBe(true);
    expect(isValidInterval(0)).toBe(false);
    expect(describeInterval(15)).toBe('Every 15 minutes');
    expect(describeInterval(60)).toBe('Every 1 hour');
    expect(describeInterval(120)).toBe('Every 2 hours');
    expect(describeInterval(90)).toBe('Every 90 minutes');
  });
});

describe('scheduler before onboarding is finished', () => {
  function gated() {
    const gate = { open: false };
    const settings = createSettings(t.db, { now });
    const queue = createQueue(t.db, { now });
    return { gate, queue, settings, scheduler: createScheduler({ settings, queue, now, canScan: () => gate.open }) };
  }

  it('an already running schedule queues no scan until onboarding is done, then carries on', () => {
    const { gate, queue, settings } = gated();
    // As in an install where Start was pressed before onboarding existed.
    settings.set('scheduler', { enabled: true, intervalMinutes: 60, lastTriggeredAt: null, nextRunAt: clock.getTime() });
    const scheduler = createScheduler({ settings, queue, now, canScan: () => gate.open });
    expect(scheduler.tick()).toBe(false);
    expect(pendingScans(queue)).toBe(0);
    expect(scheduler.getState()).toMatchObject({ enabled: true, lastTriggeredAt: null });
    gate.open = true;
    expect(scheduler.tick()).toBe(true);
    expect(pendingScans(queue)).toBe(1);
  });

  it('refuses Start and Run now with a clear error', () => {
    const { scheduler, queue } = gated();
    expect(() => scheduler.start()).toThrow(OnboardingIncompleteError);
    expect(() => scheduler.runNow()).toThrow(/finish setting up/i);
    expect(scheduler.getState().enabled).toBe(false);
    expect(pendingScans(queue)).toBe(0);
  });
});
