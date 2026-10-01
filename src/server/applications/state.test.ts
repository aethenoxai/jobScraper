import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES } from '../db/schema';
import { canTransition, isTerminal, TRANSITIONS } from './state';

describe('application state machine', () => {
  it('covers every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...APPLICATION_STATUSES].sort());
  });

  it.each([
    ['PREPARING', 'READY', true],
    ['PREPARING', 'PREPARATION_FAILED', true],
    ['READY', 'APPLYING', true],
    ['READY', 'APPLIED', true],
    ['APPLYING', 'APPLIED', true],
    ['APPLYING', 'APPLICATION_SKIPPED', true],
    ['APPLIED', 'INTERVIEW', true],
    ['INTERVIEW', 'OFFER', true],
    ['PREPARING', 'APPLIED', false],
    ['READY', 'INTERVIEW', false],
    ['REJECTED', 'INTERVIEW', false],
    ['WITHDRAWN', 'READY', false],
    // A job can close at any point before applying, and come back (or be applied to anyway).
    ['PREPARATION_FAILED', 'EXPIRED', true],
    ['APPLICATION_FAILED', 'EXPIRED', true],
    ['APPLICATION_SKIPPED', 'EXPIRED', true],
    ['EXPIRED', 'READY', true],
    ['EXPIRED', 'APPLIED', true],
    ['EXPIRED', 'WITHDRAWN', true],
    ['EXPIRED', 'INTERVIEW', false],
    ['APPLYING', 'EXPIRED', true],
  ] as const)('%s → %s is %s', (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok);
  });

  it('lets a job close at any stage before applying, and never after', () => {
    for (const from of ['PREPARING', 'READY', 'APPLYING', 'PREPARATION_FAILED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED'] as const) expect(canTransition(from, 'EXPIRED')).toBe(true);
    for (const from of ['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'] as const) expect(canTransition(from, 'EXPIRED')).toBe(false);
  });

  it('knows terminal states', () => {
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('APPLIED')).toBe(false);
  });
});
