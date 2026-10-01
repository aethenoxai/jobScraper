import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createQueue } from '../queue';
import { createScheduler } from '../scheduler';
import { createSettings } from '../settings';
import { HEARTBEAT_KEY } from './heartbeat';
import { getSystemStatus } from './index';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function deps() {
  const settings = createSettings(t.db);
  const queue = createQueue(t.db);
  return { db: t.db, settings, queue, scheduler: createScheduler({ settings, queue }) };
}

describe('getSystemStatus', () => {
  it('reports an offline worker, default scheduler and empty history on a fresh install', () => {
    const s = getSystemStatus(deps());
    expect(s.worker).toEqual({ online: false, lastSeenAt: null });
    expect(s.scheduler.enabled).toBe(false);
    expect(s.lastScan).toBeNull();
    expect(s.queue).toEqual({ pending: 0, running: 0, done: 0, failed: 0 });
    expect(getSystemStatus(deps(), { now: new Date(1234) }).generatedAt).toBe(1234);
  });

  it('reports an online worker from a fresh heartbeat of a live process', () => {
    const d = deps();
    const now = new Date();
    d.settings.set(HEARTBEAT_KEY, { workerId: 'w', pid: 1, at: now.getTime() - 1000 });
    expect(getSystemStatus(d, { now, isAlive: () => true }).worker).toEqual({ online: true, lastSeenAt: now.getTime() - 1000 });
    expect(getSystemStatus(d, { now, isAlive: () => false }).worker.online).toBe(false);
  });

  it('counts queued scans', () => {
    const d = deps();
    d.scheduler.runNow();
    expect(getSystemStatus(d).queue.pending).toBe(1);
  });
});
