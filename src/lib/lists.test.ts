import { describe, expect, it } from 'vitest';
import { parseCsv, toBullets, joinPlaces, parsePlaces } from './lists';

describe('toBullets', () => {
  const prev = [{ id: 'b1', text: 'Built X' }, { id: 'b2', text: 'Led Y' }];

  it('keeps ids of unchanged lines and of lines edited in place', () => {
    expect(toBullets('Built X\nLed Y team', prev)).toEqual([{ id: 'b1', text: 'Built X' }, { id: 'b2', text: 'Led Y team' }]);
  });

  it('never gives two lines the same id', () => {
    const out = toBullets('Built X\nBuilt X\nNew', prev);
    const ids = out.map((b) => b.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out[0].id).toBe('b1');
  });

  it('drops blank lines', () => {
    expect(toBullets('\n  \nBuilt X\n', prev)).toEqual([{ id: 'b1', text: 'Built X' }]);
  });
});

describe('parseCsv', () => {
  it('splits, trims and drops empties', () => {
    expect(parseCsv(' Bangalore, Remote ,, Delhi NCR ')).toEqual(['Bangalore', 'Remote', 'Delhi NCR']);
  });
});

describe('place lists', () => {
  it('splits on commas, or on semicolons when the user qualifies places', () => {
    expect(parsePlaces('Bangalore, India')).toEqual(['Bangalore', 'India']);
    expect(parsePlaces('Cambridge, UK; Bangalore')).toEqual(['Cambridge, UK', 'Bangalore']);
    expect(joinPlaces(['Cambridge, UK', 'Bangalore'])).toBe('Cambridge, UK; Bangalore');
    expect(joinPlaces(['Bangalore', 'Remote'])).toBe('Bangalore, Remote');
  });
});
