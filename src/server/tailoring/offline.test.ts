import { describe, expect, it } from 'vitest';
import type { JobRequirements } from '../matching/analysis';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import { TailoredCvSchema } from './model';
import { offlineTailor } from './offline';

function profile(): ProfileData {
  const p = emptyProfile();
  p.personal.fullName = 'Asha Rao';
  p.headline = 'Full Stack Developer';
  p.yearsExperience = 4;
  p.skills = ['Docker', 'MongoDB', 'React', 'Node.js', 'TypeScript', 'Figma'].map((name) => ({ id: '', name, category: 'skill' as const }));
  p.experience = [
    { id: '', title: 'Senior Software Engineer', company: 'Fictional Labs', location: null, startDate: '2023-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Organised team offsites' }, { id: '', text: 'Built a React and TypeScript billing dashboard used by 1,200 customers' }] },
  ];
  p.projects = [
    { id: '', name: 'Recipe app', description: 'Cooking side project', url: null, technologies: [], bullets: [] },
    { id: '', name: 'Node.js API toolkit', description: 'Open-source Node.js helpers', url: null, technologies: ['Node.js'], bullets: [] },
  ];
  return assignIds(p);
}

const analysis: JobRequirements = {
  requirements: [{ text: 'React and TypeScript', kind: 'skill', mandatory: true }, { text: 'Node.js', kind: 'skill', mandatory: true }, { text: 'Kubernetes', kind: 'skill', mandatory: false }],
  yearsExperienceMin: 3,
  seniority: 'mid',
  summary: null,
  applyEmail: null,
  skills: ['React', 'TypeScript', 'Node.js', 'Kubernetes'],
};

describe('offlineTailor', () => {
  it('produces a valid tailored CV that only reorders and selects', () => {
    const p = profile();
    const cv = offlineTailor(p, analysis, 'standard');
    expect(() => TailoredCvSchema.parse(cv)).not.toThrow();
    expect(cv.method).toBe('offline');
    expect(cv.skills.slice(0, 3)).toEqual(['React', 'TypeScript', 'Node.js']);
    expect(cv.skills).not.toContain('Kubernetes');
    const bullets = cv.experience[0].bullets;
    expect(bullets[0].text).toMatch(/^Built a React/);
    expect(bullets.every((b) => b.sources.length === 1 && p.experience[0].bullets.some((s) => s.id === b.sources[0] && s.text === b.text))).toBe(true);
    expect(cv.projects[0].id).toBe(p.projects[1].id);
  });

  it('keeps the original bullet order for light tailoring', () => {
    const cv = offlineTailor(profile(), analysis, 'light');
    expect(cv.experience[0].bullets[0].text).toBe('Organised team offsites');
  });

  it('writes a summary only from facts when the profile has none', () => {
    const cv = offlineTailor(profile(), analysis, 'standard');
    expect(cv.summary).toBe('Full Stack Developer with 4 years of experience in React, TypeScript and Node.js.');
    const withSummary = profile();
    withSummary.summary = 'My own words.';
    expect(offlineTailor(withSummary, analysis, 'standard').summary).toBe('My own words.');
  });

  it('puts education first for early-career profiles', () => {
    const p = profile();
    p.yearsExperience = 1;
    p.education = [{ id: 'edu_1', institution: 'Uni', degree: 'BSc', field: null, startDate: null, endDate: null, grade: null }];
    expect(offlineTailor(p, analysis, 'standard').sectionOrder.indexOf('education')).toBeLessThan(offlineTailor(p, analysis, 'standard').sectionOrder.indexOf('experience'));
  });
});
