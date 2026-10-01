/**
 * Validator recall and precision for the tailoring eval: changes to a grounded tailored CV that invent facts (must
 * be flagged) and ordinary edits (must not be). Invented people and companies.
 */
import { assignIds, emptyProfile, type ProfileData } from '../../src/server/profile/model';
import type { TailoredCv } from '../../src/server/tailoring/model';

export function fabricationProfile(): ProfileData {
  const p = emptyProfile();
  p.headline = 'Backend Engineer';
  p.targetTitles = ['Engineering Manager'];
  p.yearsExperience = 4;
  p.summary = 'Backend engineer who builds reliable services.';
  p.skills = ['Go', 'PostgreSQL', 'Docker', 'React'].map((name) => ({ id: '', name, category: 'technology' as const }));
  p.experience = [
    { id: 'exp_now', title: 'Backend Engineer', company: 'Example Payments', location: null, startDate: '2023-01', endDate: null, current: true, summary: null, bullets: [{ id: 'b1', text: 'Reduced API latency by 35% with caching in Go' }, { id: 'b2', text: 'Moved billing jobs to PostgreSQL, serving 1,200 merchants and $2M monthly volume' }] },
    { id: 'exp_old', title: 'Junior Developer', company: 'Sample Studio', location: null, startDate: '2021-01', endDate: '2022-12', current: false, summary: null, bullets: [{ id: 'b3', text: 'Built React screens for an internal tool' }] },
  ];
  p.education = [{ id: 'edu', institution: 'Example University', degree: 'B.Sc Computer Science', field: null, startDate: null, endDate: null, grade: null }];
  return assignIds(p);
}

export function groundedCv(): TailoredCv {
  return {
    headline: 'Backend Engineer',
    summary: 'Backend engineer with 4 years of experience in Go and PostgreSQL.',
    skills: ['Go', 'PostgreSQL', 'Docker', 'React'],
    experience: [
      { id: 'exp_now', bullets: [{ text: 'Cut API latency by 35% by adding caching in Go', sources: ['b1'] }, { text: 'Migrated billing jobs to PostgreSQL for 1,200 merchants and $2M monthly volume', sources: ['b2'] }] },
      { id: 'exp_old', bullets: [{ text: 'Built React screens for an internal tool', sources: ['b3'] }] },
    ],
    projects: [],
    education: ['edu'],
    certifications: [],
    languages: [],
    sectionOrder: ['summary', 'skills', 'experience', 'education'],
    targeted: [],
    intensity: 'standard',
    method: 'ai',
  };
}

type Change = { name: string; apply: (cv: TailoredCv) => void };
const bullet = (cv: TailoredCv, job: number, i: number, text: string) => void (cv.experience[job].bullets[i].text = text);

/** Each of these invents or removes a fact; the validator must flag every one. */
export const FABRICATIONS: Change[] = [
  { name: 'invented percentage', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by 60% by adding caching in Go') },
  { name: 'spelled-out multiplier', apply: (cv) => bullet(cv, 0, 0, 'Tripled API throughput by adding caching in Go') },
  { name: 'spelled-out count', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by 35% with caching in Go, mentoring five engineers') },
  { name: 'spelled-out percentage', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by forty percent by adding caching in Go') },
  { name: 'vague big number', apply: (cv) => bullet(cv, 0, 1, 'Migrated billing jobs to PostgreSQL used by millions of merchants') },
  { name: 'skill not in profile', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by 35% with caching on Kubernetes') },
  { name: 'skill from another role', apply: (cv) => bullet(cv, 1, 0, 'Built React screens backed by PostgreSQL for an internal tool') },
  { name: 'client name', apply: (cv) => bullet(cv, 0, 1, 'Migrated billing jobs to PostgreSQL for Stripe, 1,200 merchants and $2M monthly volume') },
  { name: 'currency changed', apply: (cv) => bullet(cv, 0, 1, 'Migrated billing jobs to PostgreSQL for 1,200 merchants and €2M monthly volume') },
  { name: 'achievement from another role', apply: (cv) => (cv.experience[1].bullets[0].sources = ['b1']) },
  { name: 'unsourced bullet', apply: (cv) => (cv.experience[0].bullets[0].sources = []) },
  { name: 'summary: years inflated', apply: (cv) => (cv.summary = 'Backend engineer with 7 years of experience in Go.') },
  { name: 'summary: a decade', apply: (cv) => (cv.summary = 'Backend engineer with over a decade of experience.') },
  { name: 'summary: 15-year career', apply: (cv) => (cv.summary = 'A 15-year career in backend engineering.') },
  { name: 'summary: invented metric', apply: (cv) => (cv.summary = 'Backend engineer who saved $5M in cloud costs.') },
  { name: 'summary: former employer', apply: (cv) => (cv.summary = 'Ex-Google backend engineer.') },
  { name: 'headline: title never held', apply: (cv) => (cv.headline = 'Engineering Manager') },
  { name: 'degree dropped', apply: (cv) => (cv.education = []) },
  { name: 'experience section dropped', apply: (cv) => (cv.sectionOrder = ['summary', 'skills', 'education']) },
  { name: 'job dropped', apply: (cv) => (cv.experience = cv.experience.slice(0, 1)) },
];

/** Ordinary tailoring edits; the validator must accept every one. */
export const NORMAL_EDITS: Change[] = [
  { name: 'rewording', apply: (cv) => bullet(cv, 0, 0, 'Lowered API latency 35% through caching in Go') },
  { name: '"percent" spelled out', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by 35 percent with caching in Go') },
  { name: '"thirty-five" for 35', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by thirty-five percent with caching in Go') },
  { name: 'reordered bullets', apply: (cv) => cv.experience[0].bullets.reverse() },
  { name: 'dropped a bullet', apply: (cv) => cv.experience[0].bullets.pop() },
  { name: 'skills reordered and trimmed', apply: (cv) => (cv.skills = ['PostgreSQL', 'Go']) },
  { name: 'previous title as headline', apply: (cv) => (cv.headline = 'Junior Developer') },
  { name: 'summary rewritten', apply: (cv) => (cv.summary = 'Backend engineer focused on Go services and PostgreSQL data, 4 years in.') },
  { name: 'section order changed', apply: (cv) => (cv.sectionOrder = ['summary', 'experience', 'skills', 'education']) },
  { name: 'tool names with digits', apply: (cv) => bullet(cv, 0, 0, 'Cut API latency by 35% with caching in Go on EC2') },
];

/** The job the letter fixtures are written for (its numbers are fine about the employer, never as the user's). */
export const LETTER_JOB = { title: 'Backend Engineer', company: 'Acme Payments', description: 'Join our team of 12 engineers. You will cut costs by 30% and own billing.' };

/** Sentences invented for a cover letter; each must be flagged. */
export const LETTER_FABRICATIONS: Array<{ name: string; text: string }> = [
  { name: 'invented metric', text: 'At Example Payments I cut infrastructure costs by 50%.' },
  { name: "the job's number claimed as mine", text: 'At Example Payments I led a team of 12 engineers.' },
  { name: "the job's percentage claimed as mine", text: 'I cut costs by 30% at Example Payments.' },
  { name: 'spelled-out multiplier', text: 'I tripled the throughput of our billing services.' },
  { name: 'years in words', text: 'I bring fifteen years of backend experience.' },
  { name: 'a decade', text: 'I have over a decade of experience.' },
  { name: 'former employer', text: 'I worked for Google on payments.' },
  { name: 'ex-employer', text: 'As an ex-Netflix engineer I care about reliability.' },
  { name: 'skill not in profile', text: 'I run Kubernetes clusters every day.' },
];

/** Ordinary letter sentences; none may be flagged. */
export const LETTER_NORMAL: Array<{ name: string; text: string }> = [
  { name: 'role and company', text: "I'm applying for the Backend Engineer role at Acme Payments." },
  { name: 'real achievement', text: 'At Example Payments I reduced API latency by 35% with caching in Go.' },
  { name: "the employer's numbers", text: 'Your team of 12 engineers sounds like a great place to grow.' },
  { name: 'school', text: 'I studied computer science at Example University.' },
  { name: 'years as stated', text: 'I have 4 years of experience with Go and PostgreSQL.' },
  { name: 'possessive', text: "I'd enjoy working at Acme Payments' scale." },
];
