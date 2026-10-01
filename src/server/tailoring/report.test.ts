import { describe, expect, it } from 'vitest';
import { assignIds, emptyProfile } from '../profile/model';
import type { TailoredCv } from './model';
import { buildChangeReport } from './report';

const profile = (() => {
  const p = emptyProfile();
  p.headline = 'Developer';
  p.summary = 'Old summary.';
  p.skills = ['Docker', 'React', 'Figma'].map((name, i) => ({ id: `s${i}`, name, category: 'skill' as const }));
  p.experience = [{ id: 'exp_a', title: 'Engineer', company: 'Acme', location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [{ id: 'b1', text: 'Built X' }, { id: 'b2', text: 'Led Y' }, { id: 'b3', text: 'Organised Z' }] }];
  p.projects = [{ id: 'p1', name: 'Tool', description: null, url: null, technologies: [], bullets: [] }, { id: 'p2', name: 'Game', description: null, url: null, technologies: [], bullets: [] }];
  return assignIds(p);
})();

const cv: TailoredCv = {
  headline: 'Developer', summary: 'New focused summary.', skills: ['React', 'Docker'],
  experience: [{ id: 'exp_a', bullets: [{ text: 'Built X with React', sources: ['b1'] }, { text: 'Led Y', sources: ['b2'] }] }],
  projects: [{ id: 'p1', bullets: [] }], education: [], certifications: [], languages: [],
  sectionOrder: ['summary', 'skills', 'experience'], targeted: ['React'], intensity: 'standard', method: 'ai',
};

describe('buildChangeReport', () => {
  it('explains what changed against the master CV', () => {
    const r = buildChangeReport(profile, cv, 1);
    expect(r.summary).toEqual({ before: 'Old summary.', after: 'New focused summary.', changed: true });
    expect(r.skills).toEqual({ order: ['React', 'Docker'], movedUp: ['React'], omitted: ['Figma'] });
    expect(r.experience[0].bullets).toEqual([
      { before: ['Built X'], after: 'Built X with React', kind: 'reworded' },
      { before: ['Led Y'], after: 'Led Y', kind: 'unchanged' },
    ]);
    expect(r.experience[0].omitted).toEqual(['Organised Z']);
    expect(r.projects).toEqual({ included: ['Tool'], omitted: ['Game'] });
    expect(r).toMatchObject({ targeted: ['React'], repairs: 1, method: 'ai' });
  });

  it('reports skill moves relative to each other, understands aliases, and notes reordered sections and dropped certifications', () => {
    const p = assignIds(emptyProfile());
    p.skills = ['Java', 'Go', 'PostgreSQL', 'Docker'].map((name, i) => ({ id: `s${i}`, name, category: 'skill' as const }));
    p.certifications = [{ id: 'c1', name: 'AWS Certified Developer', issuer: null, date: null }];
    const tailored = { headline: null, summary: null, skills: ['Go', 'Postgres', 'Docker'], experience: [], projects: [], education: [], certifications: [], languages: [], sectionOrder: ['skills', 'summary'] as TailoredCv['sectionOrder'], targeted: [], intensity: 'standard' as const, method: 'ai' as const };
    const r = buildChangeReport(p, tailored, 0);
    expect(r.skills.movedUp).toEqual([]); // Java was left out; the rest kept their order
    expect(r.skills.omitted).toEqual(['Java']);
    expect(r.sectionsReordered).toBe(true);
    expect(r.certificationsOmitted).toEqual(['AWS Certified Developer']);
  });
});
