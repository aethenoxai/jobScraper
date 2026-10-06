import { describe, expect, it } from 'vitest';
import type { Ai } from '../ai';
import { routedAi } from '../ai/fake';
import type { JobRequirements } from '../matching/analysis';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import { coverLetterText, offlineCoverLetter, validateCoverLetter, writeCoverLetter, type CoverLetter } from './cover-letter';

function profile(): ProfileData {
  const p = emptyProfile();
  p.personal.fullName = 'Asha Rao';
  p.personal.email = 'asha@example.com';
  p.personal.phone = '+91 98765 43210';
  p.headline = 'Backend Engineer';
  p.yearsExperience = 5;
  p.skills = ['Go', 'PostgreSQL', 'Docker', 'React'].map((name) => ({ id: '', name, category: 'technology' as const }));
  p.experience = [
    { id: '', title: 'Backend Engineer', company: 'Example Co', location: 'Pune', startDate: '2021-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built Go services handling 2M requests a day' }, { id: '', text: 'Designed a React admin dashboard' }, { id: '', text: 'Tuned PostgreSQL queries, cutting p95 latency by 40%' }] },
    { id: '', title: 'Software Engineer', company: 'Old Corp', location: null, startDate: '2019-01', endDate: '2020-12', current: false, summary: null, bullets: [] },
  ];
  return assignIds(p);
}
const analysis: JobRequirements = {
  requirements: [
    { text: '4+ years building backend services', kind: 'experience', mandatory: true },
    { text: 'Go', kind: 'skill', mandatory: true },
    { text: 'PostgreSQL', kind: 'skill', mandatory: true },
  ],
  yearsExperienceMin: 4,
  seniority: 'senior',
  summary: null,
  applyEmail: 'jobs@acme.example',
  skills: ['Go', 'PostgreSQL'],
};
const job = { title: 'Senior Backend Engineer', company: 'Acme Payments', description: 'Join a team of 12 engineers. Requirements: 4+ years, Go, PostgreSQL.' };

function fakeAi(outputs: unknown[], prompts: string[] = []): Ai {
  return routedAi(['cover-letter'], async (req) => {
      prompts.push(req.prompt);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next as never;
    },);
}
const letter = (paragraphs: string[]): Omit<CoverLetter, 'method'> => ({ greeting: 'Dear Acme Payments hiring team,', paragraphs, closing: 'Kind regards,' });

describe('offline cover letter', () => {
  it('is specific to the job and built only from profile facts', () => {
    const l = offlineCoverLetter(profile(), analysis, job);
    const text = coverLetterText(l, profile());
    expect(text).toContain('Senior Backend Engineer');
    expect(text).toContain('Acme Payments');
    expect(text).toContain('5 years');
    expect(text).toContain('Built Go services handling 2M requests a day');
    expect(text).not.toContain('React admin dashboard'); // not what this job asks for
    expect(text).toMatch(/Asha Rao[\s\S]*asha@example\.com/);
    expect(l.method).toBe('offline');
    expect(validateCoverLetter(l, profile(), job)).toEqual([]);
  });
});

describe('validateCoverLetter', () => {
  const check = (paragraphs: string[]) => validateCoverLetter({ ...letter(paragraphs), method: 'ai' }, profile(), job).map((v) => v.message).join(' | ');

  it('accepts normal prose about the role, the company and real experience', () => {
    expect(check(['I am applying for the Senior Backend Engineer role at Acme Payments.', 'At Example Co I built Go services handling 2M requests a day and cut p95 latency by 40%.', 'With 5 years of experience, I would enjoy contributing.', 'Your team of 12 engineers sounds like a great fit.'])).toBe('');
  });

  it('catches what the CV validator catches: spelled-out years, quantity words, former employers, job numbers claimed as mine', () => {
    expect(check(['I bring fifteen years of backend experience.'])).toMatch(/years/);
    expect(check(['I bring over a decade of experience.'])).toMatch(/years/);
    expect(check(['I tripled the throughput of our services.'])).toMatch(/tripled/i);
    expect(check(['I worked for Google on payments.'])).toMatch(/Google/);
    expect(check(['As an ex-Google engineer I care about reliability.'])).toMatch(/Google/);
    // 12 is in the job posting: fine about their team, not as my achievement.
    expect(check(['At Example Co I led a team of 12 engineers.'])).toMatch(/12/);
  });

  it('allows schools, skills from my own bullets and possessives of the company', () => {
    const p = profile();
    p.education = [{ id: 'edu_1', institution: 'IIT Bombay', degree: 'B.Tech', field: null, startDate: null, endDate: null, grade: null }];
    p.experience[0].bullets.push({ id: 'bul_k', text: 'Built Kafka pipelines for billing events' });
    const ok = (paragraphs: string[]) => validateCoverLetter({ ...letter(paragraphs), method: 'ai' }, p, job).map((v) => v.message).join(' | ');
    expect(ok(['I studied at IIT Bombay.'])).toBe('');
    expect(ok(['I built Kafka pipelines for billing events.'])).toBe('');
    expect(ok(["I'd enjoy working at Acme Payments' scale."])).toBe('');
  });

  it('catches invented numbers, employers, skills and years', () => {
    expect(check(['I cut latency by 70%.'])).toMatch(/70%/);
    expect(check(['At Google I led the payments team.'])).toMatch(/Google/);
    expect(check(['I run Kubernetes clusters every day.'])).toMatch(/Kubernetes/);
    expect(check(['I bring 9 years of backend experience.'])).toMatch(/years/);
  });
});

describe('writeCoverLetter', () => {
  const good = letter(['I am applying for the Senior Backend Engineer role at Acme Payments.', 'At Example Co I built Go services handling 2M requests a day.']);
  const bad = letter(['At Google I scaled Kubernetes to 10M users.']);

  it('uses a grounded AI letter', async () => {
    const r = await writeCoverLetter({ profile: profile(), analysis, job, ai: fakeAi([good]) });
    expect(r.letter).toMatchObject({ method: 'ai', paragraphs: good.paragraphs });
    expect(r.repairs).toBe(0);
  });

  it('asks once for a fix, then falls back to the offline letter', async () => {
    const prompts: string[] = [];
    const fixed = await writeCoverLetter({ profile: profile(), analysis, job, ai: fakeAi([bad, good], prompts) });
    expect(fixed.letter.method).toBe('ai');
    expect(prompts[1]).toMatch(/Google/);
    const fallback = await writeCoverLetter({ profile: profile(), analysis, job, ai: fakeAi([bad, bad]) });
    expect(fallback.letter.method).toBe('offline');
    expect(fallback.repairs).toBeGreaterThan(0);
  });

  it('writes offline without AI, and stops on shutdown', async () => {
    expect((await writeCoverLetter({ profile: profile(), analysis, job, ai: null })).letter.method).toBe('offline');
    const ac = new AbortController();
    ac.abort();
    await expect(writeCoverLetter({ profile: profile(), analysis, job, ai: fakeAi([new Error('aborted')]), signal: ac.signal })).rejects.toThrow();
  });
});
