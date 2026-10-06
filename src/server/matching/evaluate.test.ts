import { describe, expect, it } from 'vitest';
import type { Ai } from '../ai';
import { routedAi } from '../ai/fake';
import { assignIds, DEFAULT_SLIDER, emptyProfile, type ProfileData } from '../profile/model';
import type { JobRequirements } from './analysis';
import { evaluateMatch, heuristicEvaluate } from './evaluate';
import { computeScore, decide, profileSeniority, seniorityGap } from './score';

function engineer(): ProfileData {
  const p = emptyProfile();
  p.headline = 'Backend Engineer';
  p.yearsExperience = 6;
  p.skills = ['Go', 'PostgreSQL', 'Docker', 'Java'].map((name) => ({ id: '', name, category: 'technology' as const }));
  p.experience = [{ id: '', title: 'Backend Engineer', company: 'Acme', location: null, startDate: '2020-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built payment APIs in Go serving 2M requests/day' }] }];
  p.education = [{ id: '', institution: 'Example University', degree: 'B.Sc. Computer Science', field: null, startDate: null, endDate: null, grade: null }];
  p.languages = [{ id: '', name: 'English', proficiency: 'Fluent' }];
  return assignIds(p);
}

const analysis: JobRequirements = {
  requirements: [
    { text: '5+ years of experience building backend services', kind: 'experience', mandatory: true },
    { text: 'Strong Go or Java skills', kind: 'skill', mandatory: true },
    { text: 'Experience with PostgreSQL and Kafka', kind: 'skill', mandatory: true },
    { text: "Bachelor's degree in Computer Science", kind: 'education', mandatory: true },
    { text: 'Kubernetes', kind: 'skill', mandatory: false },
  ],
  yearsExperienceMin: 5,
  seniority: 'senior',
  summary: null,
  applyEmail: null,
  skills: ['Go', 'Java', 'PostgreSQL', 'Kafka', 'Kubernetes'],
};

describe('heuristicEvaluate', () => {
  const e = heuristicEvaluate(analysis, engineer(), 1);
  const status = (t: string) => e.requirements.find((r) => r.text.startsWith(t))?.status;

  it('judges each requirement against the profile with evidence', () => {
    expect(status('5+ years')).toBe('met');
    expect(status('Strong Go or Java')).toBe('met');
    expect(status('Experience with PostgreSQL and Kafka')).toBe('partial');
    expect(status("Bachelor's")).toBe('met');
    expect(status('Kubernetes')).toBe('unmet');
    expect(e.requirements.find((r) => r.text.startsWith('Strong Go'))!.evidence.length).toBeGreaterThan(0);
  });

  it('lists strengths and gaps in plain words', () => {
    expect(e.strengths.length).toBeGreaterThan(0);
    expect(e.gaps.join(' ')).toMatch(/Kafka/);
  });
});

describe('evaluateMatch with AI', () => {
  it('downgrades "met" answers whose evidence is not in the profile and fills gaps offline', async () => {
    const profile = engineer();
    const skillId = profile.skills[0].id;
    const ai: Ai = routedAi(['match-evaluate'], async () =>
        ({ requirements: [{ index: 0, status: 'met', evidence: [profile.experience[0].id], note: null }, { index: 1, status: 'met', evidence: ['invented_id'], note: null }, { index: 2, status: 'met', evidence: [skillId], note: null }], roleFit: 90, strengths: ['Go'], gaps: [] }) as never,);
    const e = await evaluateMatch(analysis, profile, 1, { ai });
    expect(e.method).toBe('ai');
    expect(e.requirements[0].status).toBe('met');
    expect(e.requirements[1].status).toBe('partial');
    expect(e.requirements[4].status).toBe('unmet'); // not answered by the model → offline judgement
  });

  it('falls back to the offline evaluation when AI fails', async () => {
    const ai: Ai = routedAi(['match-evaluate'], async () => { throw new Error('budget'); });
    expect((await evaluateMatch(analysis, engineer(), 1, { ai })).method).toBe('heuristic');
  });
});

describe('computeScore and decide', () => {
  const evaluation = heuristicEvaluate(analysis, engineer(), 1);

  it('scores a strong fit highly with a readable breakdown', () => {
    const s = computeScore({ evaluation, yearsRequired: 5, profileYears: 6, locationFit: 1, salaryFit: 1 });
    expect(s.score).toBeGreaterThanOrEqual(80);
    expect(Object.keys(s.components).sort()).toEqual(['experience', 'location', 'mustHave', 'other', 'role', 'skills']);
  });

  it('caps the score when a hard requirement (licence, language, work permit) is unmet', () => {
    const certified = engineer();
    certified.certifications = [{ id: 'crt_aws', name: 'AWS Solutions Architect', issuer: 'Amazon', date: null }];
    const nurseEval = heuristicEvaluate({ ...analysis, requirements: [...analysis.requirements, { text: 'NMC registration', kind: 'certification', mandatory: true }] }, certified, 1);
    const s = computeScore({ evaluation: nurseEval, yearsRequired: 5, profileYears: 6, locationFit: 1, salaryFit: 1 });
    expect(s.score).toBeLessThanOrEqual(60);
    expect(s.cappedBy).toMatch(/NMC/);
  });

  it('penalises missing experience and a salary below the minimum', () => {
    const full = computeScore({ evaluation, yearsRequired: 5, profileYears: 6, locationFit: 1, salaryFit: 1 }).score;
    expect(computeScore({ evaluation, yearsRequired: 5, profileYears: 1, locationFit: 1, salaryFit: 1 }).score).toBeLessThan(full);
    expect(computeScore({ evaluation, yearsRequired: 5, profileYears: 6, locationFit: 1, salaryFit: 0.3 }).score).toBeLessThan(full);
  });

  it('a posting whose requirements couldn’t be read is judged on its title: a clear title match is shown, a partial one isn’t', () => {
    const unread = (roleFit: number) => computeScore({ evaluation: { requirements: [], roleFit, strengths: [], gaps: [], method: 'heuristic' }, yearsRequired: null, profileYears: 5, locationFit: 1, salaryFit: 1 }).score;
    // At the default slider (what a new user has).
    expect(decide(unread(1), DEFAULT_SLIDER).decision).toBe('surfaced');
    expect(decide(unread(0.5), DEFAULT_SLIDER).decision).toBe('filtered');
    // A guess from the title ranks below matches with real evidence (just above the default threshold).
    expect(unread(1)).toBeLessThanOrEqual(82);
    expect(unread(1)).toBeLessThan(computeScore({ evaluation, yearsRequired: 5, profileYears: 6, locationFit: 1, salaryFit: 1 }).score);
  });

  it('decides against the slider threshold', () => {
    expect(decide(80, 100)).toEqual({ decision: 'surfaced', threshold: 76 });
    expect(decide(80, 200)).toMatchObject({ decision: 'filtered', threshold: 95 });
    expect(decide(80, 200).reason).toMatch(/80%.*95%/);
  });
});

describe('hard-requirement cap only for truly unmet hard requirements (review C1)', () => {
  const base = (reqs: JobRequirements['requirements']): JobRequirements => ({ requirements: reqs, yearsExperienceMin: null, seniority: null, summary: null, applyEmail: null, skills: [] });
  const score = (p: ProfileData, a: JobRequirements) => computeScore({ evaluation: heuristicEvaluate(a, p, 1), yearsRequired: null, profileYears: p.yearsExperience, locationFit: 1, salaryFit: 1 });

  it('"Proficient in JavaScript" is a skill, not a language', async () => {
    const { heuristicAnalysis } = await import('./analysis');
    const a = heuristicAnalysis('React Native Developer', 'Requirements\n• Proficient in JavaScript and TypeScript\n• 3+ years with React Native\n• Experience with cloud-native tooling');
    expect(a.requirements.map((r) => r.kind)).toEqual(['skill', 'experience', 'other']);
  });

  it('a qualification is met by a certification that names it in other words', () => {
    const p = emptyProfile();
    p.certifications = [{ id: '', name: 'Qualified Teacher Status (QTS)', issuer: null, date: null }];
    const s = score(assignIds(p), base([{ text: 'Teaching qualification', kind: 'certification', mandatory: true }]));
    expect(s.cappedBy).toBeNull();
  });

  it('generic words like "certificate" never match an unrelated certification', () => {
    const p = emptyProfile();
    p.certifications = [{ id: '', name: 'AWS Certified Developer', issuer: null, date: null }];
    const s = score(assignIds(p), base([{ text: 'Food hygiene certificate', kind: 'certification', mandatory: true }]));
    expect(s.cappedBy).toMatch(/Food hygiene/);
  });

  it('a nurse whose title shows the registration is not capped', () => {
    const p = emptyProfile();
    p.headline = 'Registered Nurse';
    p.experience = [{ id: '', title: 'Registered Nurse', company: 'Hospital', location: null, startDate: '2019', endDate: null, current: true, summary: null, bullets: [] }];
    p.certifications = [{ id: '', name: 'RN License (Texas BON)', issuer: null, date: null }];
    const s = score(assignIds(p), base([{ text: 'Must be a Registered Nurse', kind: 'certification', mandatory: true }]));
    expect(s.cappedBy).toBeNull();
  });

  it('missing profile data (no languages, no work authorization) never caps', () => {
    const p = assignIds(emptyProfile());
    const s = score(p, base([{ text: 'Fluent German', kind: 'language', mandatory: true }, { text: 'Authorized to work in the US', kind: 'authorization', mandatory: true }]));
    expect(s.cappedBy).toBeNull();
  });

  it('a stated, different language still caps', () => {
    const p = emptyProfile();
    p.languages = [{ id: '', name: 'English', proficiency: 'Native' }];
    expect(score(assignIds(p), base([{ text: 'Fluent German', kind: 'language', mandatory: true }])).cappedBy).toMatch(/German/);
  });

  it('a driving licence is not treated as a professional certification', async () => {
    const { heuristicAnalysis } = await import('./analysis');
    expect(heuristicAnalysis('Field Sales', "Requirements\n• Valid driver's license").requirements[0].kind).toBe('other');
  });

  it('AI "unmet" for authorization becomes partial when the profile does not say', async () => {
    const ai = routedAi(['match-evaluate'], async () => ({ requirements: [{ index: 0, status: 'unmet', evidence: [], note: null }], roleFit: 80, strengths: [], gaps: [] }) as never);
    const e = await evaluateMatch(base([{ text: 'Must be authorized to work in the US', kind: 'authorization', mandatory: true }]), assignIds(emptyProfile()), 1, { ai });
    expect(e.requirements[0].status).toBe('partial');
  });
});

describe('seniority', () => {
  const evaluation = heuristicEvaluate(analysis, engineer(), 1);
  const base = { evaluation, yearsRequired: null, profileYears: 6, locationFit: 1, salaryFit: 1 };

  it('reads the user’s level from their latest title, else their years', () => {
    const p = engineer();
    expect(profileSeniority(p)).toBe('mid');
    p.experience = [{ id: 'exp_1', title: 'Staff Engineer', company: 'X', location: null, startDate: '2020-01', endDate: null, current: true, summary: null, bullets: [] }];
    expect(profileSeniority(p)).toBe('lead');
    p.experience = [];
    p.yearsExperience = 0.5;
    expect(profileSeniority(p)).toBe('entry');
  });

  it('a two-level gap weakens the experience part of the score', () => {
    expect(seniorityGap('senior', 'junior')).toBe(2);
    expect(seniorityGap('lead', 'junior')).toBe(3);
    const s = computeScore({ ...base, seniorityGap: 2 });
    expect(s.components.experience).toBe(0.4);
  });

  it('a gap of three levels or more caps the score, either way round', () => {
    for (const gap of [3, -3, 5]) {
      const s = computeScore({ ...base, seniorityGap: gap });
      expect(s.score).toBeLessThanOrEqual(65);
      expect(s.cappedBy).toMatch(/level/i);
      expect(s.capKind).toBe('seniority');
    }
    expect(computeScore({ ...base, seniorityGap: 1 }).score).toBeGreaterThan(65);
    expect(seniorityGap('intern', 'lead')).toBe(-4);
    expect(seniorityGap(null, 'lead')).toBeNull();
  });
});
