import { describe, expect, it } from 'vitest';
import {
  assignIds,
  computeYearsOfExperience,
  DEFAULT_PREFERENCES,
  emptyProfile,
  formatExpectedSalary,
  missingFields,
  PreferencesSchema,
  ProfileDataSchema,
  type ProfileData,
} from './model';

function withJobs(jobs: Array<{ start: string | null; end: string | null; current?: boolean }>): ProfileData {
  const p = emptyProfile();
  p.experience = jobs.map((j, i) => ({
    id: `exp_${i}`,
    title: 'Engineer',
    company: `Co ${i}`,
    location: null,
    startDate: j.start,
    endDate: j.end,
    current: j.current ?? false,
    summary: null,
    bullets: [],
  }));
  return p;
}

describe('profile model', () => {
  it('an empty profile is valid and has no invented values', () => {
    const p = emptyProfile();
    expect(ProfileDataSchema.parse(p)).toEqual(p);
    expect(p.personal.fullName).toBeNull();
    expect(p.skills).toEqual([]);
  });

  it('assignIds gives every list item and bullet a unique stable id', () => {
    const p = emptyProfile();
    p.skills = [{ id: '', name: 'React', category: 'technology' }, { id: 'skl_keep', name: 'SQL', category: 'skill' }];
    p.experience = [
      { id: '', title: 'Dev', company: 'A', location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [{ id: '', text: 'Built X' }, { id: '', text: 'Led Y' }] },
    ];
    const once = assignIds(p);
    const ids = [...once.skills.map((s) => s.id), once.experience[0].id, ...once.experience[0].bullets.map((b) => b.id)];
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(once.skills[1].id).toBe('skl_keep');
    expect(assignIds(once)).toEqual(once);
  });

  it('computes years of experience merging overlapping jobs', () => {
    const now = new Date('2026-10-01');
    expect(computeYearsOfExperience(withJobs([{ start: '2020-01', end: '2022-01' }]), now)).toBe(2);
    expect(computeYearsOfExperience(withJobs([{ start: '2020-01', end: '2022-01' }, { start: '2021-01', end: '2023-01' }]), now)).toBe(3);
    expect(computeYearsOfExperience(withJobs([{ start: '2024-10', end: null, current: true }]), now)).toBe(2);
    expect(computeYearsOfExperience(withJobs([{ start: null, end: '2020-01' }]), now)).toBeNull();
  });

  it('lists the important fields that are still missing', () => {
    const p = emptyProfile();
    p.personal.fullName = 'Asha Rao';
    const missing = missingFields(p);
    expect(missing).toContain('personal.email');
    expect(missing).toContain('application.noticePeriod');
    expect(missing).not.toContain('personal.fullName');
  });

  it('preferences default to a sane, valid configuration', () => {
    expect(PreferencesSchema.parse(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES);
    expect(() => PreferencesSchema.parse({ ...DEFAULT_PREFERENCES, workModes: ['moon'] })).toThrow();
  });
});

describe('expected salary', () => {
  it('older saved preferences (no negotiable flag) still read, as not negotiable', () => {
    const { salaryNegotiable, ...older } = { ...DEFAULT_PREFERENCES, salaryMin: 1_200_000, salaryCurrency: 'INR' };
    void salaryNegotiable;
    const read = PreferencesSchema.parse(older);
    expect(read.salaryMin).toBe(1_200_000);
    expect(read.salaryNegotiable ?? false).toBe(false);
    expect('salaryNegotiable' in read).toBe(false);
  });

  it('is written out for application answers in the way people write it', () => {
    expect(formatExpectedSalary({ ...DEFAULT_PREFERENCES, salaryMin: 2_400_000, salaryCurrency: 'INR', salaryNegotiable: true })).toBe('2,400,000 INR per year (negotiable)');
    expect(formatExpectedSalary({ ...DEFAULT_PREFERENCES, salaryMin: 95_000, salaryCurrency: 'EUR' })).toBe('95,000 EUR per year');
    expect(formatExpectedSalary({ ...DEFAULT_PREFERENCES, salaryMin: 95_000, salaryCurrency: null })).toBe('95,000 per year');
    expect(formatExpectedSalary(DEFAULT_PREFERENCES)).toBeNull();
  });
});
