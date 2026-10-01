import { describe, expect, it } from 'vitest';
import { composeLocations, countryChoices, locationMatches, placeChoices, resolvePlaces, unrecognisedPlaces } from './geo';

describe('resolvePlaces', () => {
  it('knows cities, their aliases and countries', () => {
    const p = resolvePlaces('Bengaluru, Karnataka, India');
    expect([...p.cities]).toEqual(['bangalore']);
    expect(p.countries.has('IN')).toBe(true);
    expect(resolvePlaces('Gurugram').cities.has('delhi ncr')).toBe(true);
    expect(resolvePlaces('New York, NY').countries.has('US')).toBe(true);
    expect(resolvePlaces('London, UK').countries.has('GB')).toBe(true);
  });

  it('recognises remote and regions', () => {
    expect(resolvePlaces('Remote (EMEA)')).toMatchObject({ remote: true });
    expect(resolvePlaces('Remote (EMEA)').countries.has('DE')).toBe(true);
    expect(resolvePlaces('Anywhere in the world').worldwide).toBe(true);
    expect(resolvePlaces('USA').countries.has('US')).toBe(true);
  });
});

const prefs = (locations: string[], remoteScope: 'none' | 'country' | 'worldwide' = 'country') => ({ locations, remoteScope });

describe('locationMatches', () => {
  it('accepts jobs in a preferred city under another name', () => {
    expect(locationMatches('Bengaluru, India', 'onsite', prefs(['Bangalore'])).ok).toBe(true);
    expect(locationMatches('Noida', 'hybrid', prefs(['Delhi NCR'])).ok).toBe(true);
  });

  it('rejects onsite jobs in other cities', () => {
    const r = locationMatches('Mumbai, India', 'onsite', prefs(['Bangalore']));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Mumbai/);
  });

  it('accepts country-level jobs when the user listed that country or a city in it', () => {
    expect(locationMatches('India', null, prefs(['Bangalore'])).ok).toBe(true);
    expect(locationMatches('Pune, India', 'onsite', prefs(['India'])).ok).toBe(true);
  });

  it('handles remote jobs by scope', () => {
    expect(locationMatches('Remote (US)', 'remote', prefs(['Bangalore'])).ok).toBe(false);
    expect(locationMatches('Remote - India', 'remote', prefs(['Bangalore'])).ok).toBe(true);
    expect(locationMatches('Worldwide', 'remote', prefs(['Bangalore'])).ok).toBe(true);
    expect(locationMatches('Remote (US)', 'remote', prefs(['Bangalore'], 'worldwide')).ok).toBe(true);
    expect(locationMatches('Remote', 'remote', prefs(['Bangalore'], 'none')).ok).toBe(false);
    expect(locationMatches('Remote (EMEA)', 'remote', prefs(['London'])).ok).toBe(true);
  });

  it('accepts everything when no locations are set, and unknown locations with low confidence', () => {
    expect(locationMatches('Tokyo', 'onsite', prefs([])).ok).toBe(true);
    const r = locationMatches(null, null, prefs(['Bangalore']));
    expect(r).toMatchObject({ ok: true, fit: 0.6 });
  });
});

describe('ambiguous places', () => {
  it('an explicit country or state wins over a city’s usual country', () => {
    expect([...resolvePlaces('London, Ontario, Canada').countries]).toEqual(['CA']);
    expect(resolvePlaces('London, Ontario, Canada').cities.has('london')).toBe(false);
    expect([...resolvePlaces('London, ON').countries]).toEqual(['CA']);
    expect([...resolvePlaces('Cambridge, MA').countries]).toEqual(['US']);
    expect([...resolvePlaces('Birmingham, AL').countries]).toEqual(['US']);
    expect([...resolvePlaces('Perth, Scotland').countries]).toEqual(['GB']);
    expect([...resolvePlaces('London, UK').cities]).toEqual(['london']);
  });

  it('two-letter codes are read from the city they follow', () => {
    expect([...resolvePlaces('San Francisco, CA').countries]).toEqual(['US']);
    expect([...resolvePlaces('Toronto, ON, CA').countries]).toEqual(['CA']);
    expect([...resolvePlaces('Bengaluru, IN').countries]).toEqual(['IN']);
    expect([...resolvePlaces('Chicago, IL').countries]).toEqual(['US']);
    expect([...resolvePlaces('Tel Aviv, IL').countries]).toEqual(['IL']);
    expect([...resolvePlaces('Perth, WA').countries]).toEqual(['AU']);
    expect([...resolvePlaces('Denver, CO').countries]).toEqual(['US']);
    // Without a known city an ambiguous code says nothing (Indiana or India?).
    expect(resolvePlaces('Fishers, IN').countries.size).toBe(0);
    expect([...resolvePlaces('Austin, TX').countries]).toEqual(['US']);
  });

  it('codes count only as whole segments, except unambiguous country codes', () => {
    expect(resolvePlaces('Work IN Office, Pune').countries.has('US')).toBe(false);
    expect(resolvePlaces('US Remote').countries.has('US')).toBe(true);
    expect(resolvePlaces('Remote - UK').countries.has('GB')).toBe(true);
  });

  it('jobs in a same-named city elsewhere do not match', () => {
    expect(locationMatches('London, ON', 'onsite', prefs(['London'])).ok).toBe(false);
    expect(locationMatches('Cambridge, MA', 'onsite', prefs(['Cambridge, UK'])).ok).toBe(false);
    expect(locationMatches('London, England', 'onsite', prefs(['London'])).ok).toBe(true);
  });

  it('preferred places the gazetteer does not know match by name', () => {
    expect(locationMatches('Mangalore, Karnataka, India', 'onsite', prefs(['Mangalore'])).ok).toBe(true);
    expect(locationMatches('Mumbai, India', 'onsite', prefs(['Mangalore'])).ok).toBe(false);
    expect(locationMatches('Mangalore', 'onsite', prefs(['Bangalore', 'Mangalore'])).ok).toBe(true);
    expect(locationMatches('Somewhere', 'onsite', prefs(['Mangalore'])).fit).toBe(0.6);
  });

  it('lists preferred places it cannot recognise', () => {
    expect(unrecognisedPlaces(['Bangalore', 'Mangalore', 'Remote', 'Bavaria'])).toEqual(['Mangalore', 'Bavaria']);
  });
});

describe('“Remote” as the only location (found with real feeds)', () => {
  const remoteOnly = { locations: ['Remote'], remoteScope: 'country' as const };
  it('shows remote jobs, and no on-site or unspecified jobs in a named place', () => {
    expect(locationMatches('Remote', null, remoteOnly).ok).toBe(true);
    expect(locationMatches('Berlin', 'remote', remoteOnly).ok).toBe(true);
    expect(locationMatches('Berlin', null, remoteOnly)).toMatchObject({ ok: false, reason: expect.stringMatching(/only want remote/) });
    expect(locationMatches('Berlin', 'hybrid', remoteOnly).ok).toBe(false);
    // Nothing known about the place: kept, with a lower fit.
    expect(locationMatches(null, null, remoteOnly)).toMatchObject({ ok: true, fit: 0.6 });
  });
});

describe('Indian states (setup asks for state and city)', () => {
  const prefs = (...locations: string[]) => ({ locations, remoteScope: 'country' as const });

  it('a job in a city matches the state it is in, not another state', () => {
    expect(locationMatches('Bengaluru, India', 'onsite', prefs('Karnataka, India'))).toMatchObject({ ok: true, fit: 1 });
    expect(locationMatches('Pune', 'hybrid', prefs('Maharashtra, India'))).toMatchObject({ ok: true, fit: 1 });
    expect(locationMatches('Bengaluru, India', 'onsite', prefs('Maharashtra, India')).ok).toBe(false);
    expect(locationMatches('Hyderabad, Telangana', 'onsite', prefs('Telangana, India')).ok).toBe(true);
  });

  it('knows the smaller states too, and keeps the country for remote jobs', () => {
    expect(resolvePlaces('Uttarakhand, India')).toMatchObject({ states: new Set(['uttarakhand']), countries: new Set(['IN']) });
    expect(locationMatches('Remote - India', 'remote', prefs('Karnataka, India')).ok).toBe(true);
    expect(locationMatches('Remote - US', 'remote', prefs('Karnataka, India')).ok).toBe(false);
  });

  it('a state with known cities is not reported as unrecognised', () => {
    expect(unrecognisedPlaces(['Karnataka, India', 'Bavaria'])).toEqual(['Bavaria']);
  });
});

describe('place choices for the setup pickers', () => {
  it('lists countries by name', () => {
    const countries = countryChoices();
    expect(countries).toContainEqual({ code: 'IN', name: 'India' });
    expect(countries).toContainEqual({ code: 'GB', name: 'United Kingdom' });
    expect(countries.map((c) => c.name)).toEqual([...countries.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('lists the states and cities of a country', () => {
    const india = placeChoices('IN');
    expect(india.states).toContain('Karnataka');
    expect(india.states).toContain('Tamil Nadu');
    expect(india.cities).toContain('Bangalore');
    expect(india.cities).toContain('Delhi NCR');
    expect(placeChoices('US').states).toContain('California');
    expect(placeChoices('DE').states).toEqual(expect.arrayContaining(['Bavaria']));
    expect(placeChoices('ZZ')).toEqual({ states: [], cities: [] });
  });

  it('turns choices into locations, the most specific first, each with its country', () => {
    expect(composeLocations('India', [], [])).toEqual(['India']);
    expect(composeLocations('India', ['Karnataka'], [])).toEqual(['Karnataka, India']);
    expect(composeLocations('India', ['Karnataka'], ['Bangalore', 'Mysore'])).toEqual(['Bangalore, India', 'Mysore, India']);
    for (const l of composeLocations('India', ['Karnataka'], ['Bangalore'])) expect(resolvePlaces(l).countries.has('IN')).toBe(true);
  });
});
