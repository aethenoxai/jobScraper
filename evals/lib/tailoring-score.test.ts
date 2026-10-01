import { describe, expect, it } from 'vitest';
import { heuristicAnalysis } from '../../src/server/matching/analysis';
import { assignIds, emptyProfile } from '../../src/server/profile/model';
import { offlineTailor } from '../../src/server/tailoring/offline';
import { coverage, evidencedKeywords, prominentMasterText, prominentTailoredText } from './tailoring-score';

function profile() {
  const p = emptyProfile();
  p.headline = 'Backend Engineer';
  p.skills = ['Java', 'Docker', 'Go', 'PostgreSQL'].map((name) => ({ id: '', name, category: 'technology' as const }));
  p.experience = [
    { id: '', title: 'Engineer', company: 'X', location: null, startDate: '2020', endDate: null, current: true, summary: null, bullets: ['Wrote Java batch jobs', 'Ran Docker builds', 'Maintained Jenkins', 'Built Go services on PostgreSQL'].map((text) => ({ id: '', text })) },
  ];
  return assignIds(p);
}

describe('tailoring eval scoring', () => {
  it('counts only job keywords the profile can back up', () => {
    const analysis = heuristicAnalysis('Backend Engineer', 'Requirements\n• Go\n• PostgreSQL\n• Kubernetes');
    expect(evidencedKeywords(profile(), analysis).sort()).toEqual(['Go', 'PostgreSQL']);
  });

  it('measures how many of them appear where a reader looks first', () => {
    const p = profile();
    const analysis = heuristicAnalysis('Backend Engineer', 'Requirements\n• Go\n• PostgreSQL');
    const keys = evidencedKeywords(p, analysis);
    const master = coverage(keys, prominentMasterText(p));
    const tailored = coverage(keys, prominentTailoredText(offlineTailor(p, analysis, 'standard')));
    expect(tailored).toBeGreaterThanOrEqual(master);
    expect(coverage([], 'anything')).toBe(1);
  });
});
