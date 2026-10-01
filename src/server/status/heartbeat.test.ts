import { describe, expect, it } from 'vitest';
import { heartbeatLive, isWorkerOnline } from './heartbeat';

const now = new Date('2026-10-01T10:00:00Z');
const beat = (agoMs: number, host?: string) => ({ workerId: 'w', pid: 4242, at: now.getTime() - agoMs, ...(host ? { host } : {}) });

describe('heartbeat (round 2: Docker containers)', () => {
  it('on this machine, checks that the process is alive', () => {
    expect(isWorkerOnline(beat(1000, 'here'), now, () => false, 'here')).toBe(false);
    expect(isWorkerOnline(beat(1000, 'here'), now, () => true, 'here')).toBe(true);
  });

  it('from another machine or container (its process can’t be checked from here), trusts a fresh heartbeat', () => {
    expect(isWorkerOnline(beat(1000, 'container-a'), now, () => false, 'container-b')).toBe(true);
    expect(isWorkerOnline(beat(60_000, 'container-a'), now, () => false, 'container-b')).toBe(false);
    expect(heartbeatLive(beat(60_000, 'container-a'), now, () => false, 'container-b', 120_000)).toBe(false);
  });
});
