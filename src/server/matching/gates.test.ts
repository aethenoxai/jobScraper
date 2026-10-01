import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, emptyProfile, type Preferences } from '../profile/model';
import { applyGates, mentions, titleFit, type GateJob } from './gates';

const job = (over: Partial<GateJob> = {}): GateJob => ({ title: 'Senior Backend Engineer', company: 'Acme', location: 'Bangalore, India', workMode: 'hybrid', employmentType: 'full-time', status: 'active', description: 'Build Go services with PostgreSQL and Kafka.', ...over });
function profile(prefs: Partial<Preferences> = {}) {
  const data = emptyProfile();
  data.headline = 'Backend Developer';
  data.skills = ['Go', 'PostgreSQL', 'Kafka', 'Docker'].map((name, i) => ({ id: `s${i}`, name, category: 'technology' as const }));
  return { data, preferences: { ...DEFAULT_PREFERENCES, locations: ['Bangalore'], targetTitles: ['Backend Engineer'], ...prefs } };
}

describe('applyGates', () => {
  it('passes a job that fits every preference', () => {
    const r = applyGates(job(), profile());
    expect(r.pass).toBe(true);
    expect(r.titleFit).toBe(1);
  });

  it.each([
    [{ status: 'expired' }, {}, /no longer listed/],
    [{ company: 'Acme Inc.' }, { excludedCompanies: ['acme'] }, /excluded company/i],
    [{ description: 'Unpaid internship' }, { excludeKeywords: ['unpaid'] }, /unpaid/],
    [{}, { includeKeywords: ['Rust'] }, /Rust/],
    [{ employmentType: 'contract' }, {}, /contract/],
    [{ workMode: 'onsite' }, { workModes: ['remote', 'hybrid'] }, /onsite/],
    [{ location: 'Mumbai' }, {}, /Mumbai/],
    [{ title: 'Registered Nurse', description: 'Patient care on wards' }, {}, /target roles/],
  ] as const)('filters %j with prefs %j', (jobOver, prefs, reason) => {
    const r = applyGates(job(jobOver as Partial<GateJob>), profile(prefs as Partial<Preferences>));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(reason);
  });

  it('lets a differently titled job through when it asks for several of the user’s skills', () => {
    const r = applyGates(job({ title: 'Platform Developer' }), profile());
    expect(r.pass).toBe(true);
    expect(r.titleFit).toBeGreaterThan(0);
  });

  it('explains employment-type mismatches in plain English (an internship, a contract role)', () => {
    expect(applyGates(job({ employmentType: 'internship' }), profile())).toMatchObject({ pass: false, reason: "It's an internship role" });
    expect(applyGates(job({ employmentType: 'contract' }), profile())).toMatchObject({ pass: false, reason: "It's a contract role" });
  });

  it('excludes companies with very short names (EY, HP, 3M) too (final review I7)', () => {
    for (const [company, excluded] of [['EY', 'ey'], ['HP Inc.', 'HP'], ['3M Company', '3m'], ['LG Electronics', 'lg']]) {
      expect(applyGates(job({ company }), profile({ excludedCompanies: [excluded] })).pass, company).toBe(false);
    }
    // Still whole words only: excluding "HP" doesn't exclude "Hotpoint" or "HPE Cloud".
    expect(applyGates(job({ company: 'Hotpoint' }), profile({ excludedCompanies: ['HP'] })).pass).toBe(true);
  });

  it('excludes companies by whole name, not by substring', () => {
    expect(applyGates(job({ company: 'Metaview' }), profile({ excludedCompanies: ['Meta'] })).pass).toBe(true);
    expect(applyGates(job({ company: 'Meta Platforms Inc.' }), profile({ excludedCompanies: ['Meta'] })).pass).toBe(false);
  });

  it('matches keywords as whole words only', () => {
    expect(applyGates(job({ description: 'We use Golang daily' }), profile({ excludeKeywords: ['go'] })).pass).toBe(true);
  });
});

describe('titleFit synonyms', () => {
  it('treats common spellings and abbreviations of a role as the same role', () => {
    expect(titleFit('Frontend Developer', ['Frontend Engineer'])).toBe(1);
    expect(titleFit('Front-End Engineer', ['Frontend Engineer'])).toBe(1);
    expect(titleFit('Fullstack Developer', ['Full Stack Engineer'])).toBe(1);
    expect(titleFit('SDE II', ['Software Engineer'])).toBe(1);
    expect(titleFit('RN - Med Surg', ['Registered Nurse'])).toBe(1);
    expect(titleFit('Maths Teacher', ['Mathematics Teacher'])).toBe(1);
    expect(titleFit('Senior AE', ['Account Executive'])).toBe(1);
    expect(titleFit('Staff Nurse', ['Software Engineer'])).toBe(0);
  });
});

describe('mentions', () => {
  it('matches short terms only where they are written as names, not everyday words', () => {
    expect(mentions('We go further for clients', 'Go')).toBe(false);
    expect(mentions('Services in Go and Rust', 'go')).toBe(true);
    expect(mentions('Our IT team', 'it')).toBe(true);
    expect(mentions('make it work', 'IT')).toBe(false);
    expect(mentions('Kubernetes and Docker', 'docker')).toBe(true);
  });
});
