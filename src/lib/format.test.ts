import { describe, expect, it } from 'vitest';
import { formatWhen, listSome, placeOf, plural } from './format';

const now = new Date('2026-10-01T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('formatWhen', () => {
  it('describes past and future times', () => {
    expect(formatWhen(null, now)).toBe('never');
    expect(formatWhen(at(-10_000), now)).toBe('just now');
    expect(formatWhen(at(10_000), now)).toBe('in a few seconds');
    expect(formatWhen(at(-5 * 60_000), now)).toBe('5 minutes ago');
    expect(formatWhen(at(30 * 60_000), now)).toBe('in 30 minutes');
    expect(formatWhen(at(-3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatWhen(at(-24 * 3_600_000), now)).toBe('yesterday');
    expect(formatWhen(now.getTime() - 5 * 60_000, now)).toBe('5 minutes ago');
  });

  it('something done a moment ago is "just now", never in the future (final review, new-user minor)', () => {
    expect(formatWhen(at(-200), now)).toBe('just now');
    expect(formatWhen(now, now)).toBe('just now');
  });
});

describe('placeOf', () => {
  it('adds the work mode only when the location doesn’t already say it', () => {
    expect(placeOf('Remote', 'remote')).toBe('Remote');
    expect(placeOf('Berlin, Germany', 'hybrid')).toBe('Berlin, Germany · hybrid');
    expect(placeOf(null, 'remote')).toBe('Location not stated · remote');
    expect(placeOf('Remoto', 'remote')).toBe('Remoto');
    expect(placeOf('Worldwide', 'remote')).toBe('Worldwide');
    expect(placeOf('Berlin (Hybrid)', 'hybrid')).toBe('Berlin (Hybrid)');
  });
});

describe('plural', () => {
  it('says "1 run" and "2 runs", with irregular plurals when given', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(2, 'run')).toBe('2 runs');
    expect(plural(0, 'listing')).toBe('0 listings');
    expect(plural(3, 'match', 'matches')).toBe('3 matches');
  });
});

describe('listSome', () => {
  it('says when a list is cut', () => {
    expect(listSome(['a', 'b'])).toBe('a, b');
    expect(listSome(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});
