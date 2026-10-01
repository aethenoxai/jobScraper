import { describe, expect, it } from 'vitest';
import { healthPayload } from './health';

const status = { generatedAt: 1, worker: { online: true, lastSeenAt: 1 }, scheduler: { enabled: true, intervalMinutes: 60, lastTriggeredAt: null, nextRunAt: null }, lastScan: null, recentScans: [], queue: { pending: 0, running: 0, done: 0, failed: 0 } };

describe('health endpoint (final review, ops minor)', () => {
  it('without a password, or when signed in, gives the full status', () => {
    expect(healthPayload(status, { passwordSet: false, signedIn: false })).toMatchObject({ ok: true, scheduler: { enabled: true } });
    expect(healthPayload(status, { passwordSet: true, signedIn: true })).toMatchObject({ ok: true, queue: { pending: 0 } });
  });

  it('with a password and no session, only says whether the app and worker are up', () => {
    expect(healthPayload(status, { passwordSet: true, signedIn: false })).toEqual({ ok: true, worker: { online: true } });
  });
});
