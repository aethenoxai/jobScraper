import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import type { ProfileRecord } from '../profile/service';
import { collectHints } from './hints';

const record = (over: { targetTitles?: string[]; prefTitles?: string[]; headline?: string | null; locations?: string[]; keywords?: string[] }): ProfileRecord => {
  const data = emptyProfile();
  data.targetTitles = over.targetTitles ?? [];
  data.headline = over.headline ?? null;
  return {
    id: 1, name: 'p', isDefault: true, sliderValue: 100, userEdited: false, createdAt: new Date(), updatedAt: new Date(), data, dataIssues: [],
    preferences: { ...DEFAULT_PREFERENCES, targetTitles: over.prefTitles ?? [], locations: over.locations ?? [], includeKeywords: over.keywords ?? [] },
  };
};

describe('collectHints', () => {
  it('merges titles, locations and keywords across profiles without duplicates', () => {
    const h = collectHints([
      record({ prefTitles: ['Backend Engineer'], targetTitles: ['backend engineer', 'Platform Engineer'], locations: ['Bangalore', 'Remote'], keywords: ['Go'] }),
      record({ prefTitles: ['Product Manager'], locations: ['bangalore'] }),
    ]);
    expect(h.titles).toEqual(['Backend Engineer', 'Product Manager', 'Platform Engineer']);
    expect(h.locations).toEqual(['Bangalore', 'Remote']);
    expect(h.keywords).toEqual(['Go']);
  });

  it('falls back to the current title when no targets are set', () => {
    expect(collectHints([record({ headline: 'Registered Nurse' })]).titles).toEqual(['Registered Nurse']);
  });
});
