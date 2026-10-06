import { describe, expect, it } from 'vitest';
import type { Ai } from '../ai';
import { routedAi } from '../ai/fake';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import { mapFields, mapWithAi, type FormField } from './fields';

function profile(): ProfileData {
  const p = emptyProfile();
  p.personal = { fullName: 'Asha Devi Rao', email: 'asha@example.com', phone: '+91 98765 43210', location: 'Pune, India', country: 'India', timezone: null, links: [{ id: '', label: 'LinkedIn', url: 'https://www.linkedin.com/in/asha-rao-example' }, { id: '', label: 'GitHub', url: 'https://github.com/asharao-example' }] };
  p.headline = 'Backend Engineer';
  p.yearsExperience = 5;
  p.experience = [{ id: '', title: 'Backend Engineer', company: 'Example Payments', location: null, startDate: '2021-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built Go services handling 2M requests a day' }] }];
  p.application = { workAuthorization: 'Indian citizen', visaStatus: null, noticePeriod: '30 days', relocation: true, travel: null, currentlyEmployed: true, currentSalary: null, expectedSalary: '30 LPA' };
  return assignIds(p);
}

const f = (key: string, label: string, over: Partial<FormField> = {}): FormField => ({ key, kind: 'text', label, name: key, required: false, options: [], ...over });
const ctx = { cvFile: '/data/applications/1/Acme_CV.pdf', coverLetterFile: '/data/applications/1/Acme_Cover_Letter.pdf', jobCountry: 'IN' as string | null };

describe('mapFields (rules from the profile)', () => {
  it('answers the standard fields from profile data', () => {
    const fields = [
      f('1', 'First Name *', { required: true }),
      f('2', 'Last Name *', { required: true }),
      f('3', 'Email *', { kind: 'email', required: true }),
      f('4', 'Phone'),
      f('5', 'Resume/CV *', { kind: 'file', required: true }),
      f('6', 'LinkedIn Profile'),
      f('7', 'Current company'),
      f('8', 'Github URL'),
      f('9', 'Notice period'),
      f('10', 'Expected salary'),
    ];
    const { answers, unanswerable } = mapFields(fields, profile(), ctx);
    const v = Object.fromEntries(answers.map((a) => [a.key, a.value]));
    expect(v).toMatchObject({ 1: 'Asha', 2: 'Devi Rao', 3: 'asha@example.com', 4: '+91 98765 43210', 5: { file: ctx.cvFile }, 6: 'https://www.linkedin.com/in/asha-rao-example', 7: 'Example Payments', 8: 'https://github.com/asharao-example', 9: '30 days', 10: '30 LPA' });
    expect(answers.every((a) => a.method === 'rule' && a.source)).toBe(true);
    expect(unanswerable).toEqual([]);
  });

  it('answers yes/no questions only when the profile says so, using the offered options', () => {
    const auth = f('a', 'Are you legally authorized to work in India? *', { kind: 'select', required: true, options: ['Yes', 'No'] });
    const sponsor = f('s', 'Will you now or in the future require visa sponsorship?', { kind: 'radio', options: ['Yes', 'No'] });
    const relocate = f('r', 'Are you willing to relocate?', { kind: 'select', options: ['Yes', 'No'] });
    const usAuth = f('u', 'Are you authorized to work in the United States? *', { kind: 'select', required: true, options: ['Yes', 'No'] });
    const { answers, unanswerable } = mapFields([auth, sponsor, relocate, usAuth], profile(), ctx);
    const v = Object.fromEntries(answers.map((a) => [a.key, a.value]));
    expect(v).toMatchObject({ a: 'Yes', s: 'No', r: 'Yes' });
    // Nothing in the profile says the user may work in the US: never guess.
    expect(unanswerable.map((x) => x.key)).toEqual(['u']);
  });

  it('declines to self-identify on diversity questions, and leaves them empty without that option', () => {
    const gender = f('g', 'Gender', { kind: 'select', options: ['Male', 'Female', 'Decline to self-identify'] });
    const race = f('r', 'Race', { kind: 'select', options: ['A', 'B'] });
    const { answers, unanswerable } = mapFields([gender, race], profile(), ctx);
    expect(answers).toEqual([expect.objectContaining({ key: 'g', value: 'Decline to self-identify' })]);
    expect(unanswerable).toEqual([]);
  });

  it('reports required questions it cannot answer', () => {
    const q = f('q', 'Describe your published work on quantum error correction *', { kind: 'textarea', required: true });
    expect(mapFields([q], profile(), ctx).unanswerable.map((x) => x.key)).toEqual(['q']);
  });
});

describe('mapWithAi (the rest, grounded)', () => {
  const ai = (out: unknown): Ai => (routedAi(['form-answers'], async () => out as never));
  const fields = [
    f('y', 'How many years of backend experience do you have? *', { required: true }),
    f('o', 'Preferred work arrangement', { kind: 'select', options: ['Remote', 'Hybrid', 'On-site'] }),
    f('x', 'Describe your work with Kubernetes *', { kind: 'textarea', required: true }),
  ];

  it('keeps answers that cite the profile and pick offered options', async () => {
    const r = await mapWithAi(fields.slice(0, 2), profile(), ai({ answers: [{ key: 'y', answer: '5', source: 'yearsExperience', evidence: '' }, { key: 'o', answer: 'Hybrid', source: 'preferences', evidence: 'Hybrid' }] }), { company: 'Acme', title: 'Engineer' });
    // "Hybrid" has no support in the profile, so it is left for the user.
    expect(r.map((a) => [a.key, a.value])).toEqual([['y', '5']]);
    expect(r.every((a) => a.method === 'ai')).toBe(true);
  });

  it('drops answers that are not grounded or not an offered option', async () => {
    const r = await mapWithAi(fields, profile(), ai({ answers: [{ key: 'y', answer: '9', source: 'yearsExperience', evidence: '9' }, { key: 'o', answer: 'Flexible', source: 'x', evidence: 'x' }, { key: 'x', answer: 'I ran Kubernetes clusters at Google for 3 years.', source: 'experience', evidence: 'Kubernetes' }] }), { company: 'Acme', title: 'Engineer' });
    expect(r).toEqual([]);
  });
});

describe('truthful legal answers (M7 review)', () => {
  const withAuth = (workAuthorization: string) => {
    const p = profile();
    p.application.workAuthorization = workAuthorization;
    p.personal.country = null;
    return p;
  };
  const authQ = (country: string) => f('a', `Are you legally authorized to work in ${country}? *`, { kind: 'select', required: true, options: ['Yes', 'No'] });
  const sponsorQ = (country: string) => f('s', `Will you now or in the future require visa sponsorship to work in ${country}? *`, { kind: 'select', required: true, options: ['Yes', 'No'] });
  const answer = (p: ProfileData, q: FormField) => mapFields([q], p, { ...ctx, jobCountry: null }).answers[0]?.value ?? null;

  it('never reads a negation as permission', () => {
    const p = withAuth('Not authorized to work in the United States; will require H-1B visa sponsorship');
    expect(answer(p, authQ('the United States'))).toBeNull();
    expect(answer(p, sponsorQ('the United States'))).toBeNull();
  });

  it('answers "no sponsorship" only for citizens and permanent residents of that country', () => {
    const p = withAuth('Citizen of India; I need visa sponsorship for the United Kingdom');
    expect(answer(p, sponsorQ('the United Kingdom'))).toBeNull();
    expect(answer(p, sponsorQ('India'))).toBe('No');
    expect(answer(withAuth('Authorized to work in the United States on an H-1B visa'), sponsorQ('the United States'))).toBeNull();
    expect(answer(withAuth('US permanent resident (green card)'), sponsorQ('the United States'))).toBe('No');
  });

  it('keeps rule answers to the offered options, and gives the CV only to CV upload fields', () => {
    const years = f('y', 'Years of experience *', { kind: 'select', required: true, options: ['0-2', '3-5', '6+'] });
    const transcript = f('t', 'Official transcript *', { kind: 'file', required: true });
    const r = mapFields([years, transcript], profile(), ctx);
    expect(r.answers).toEqual([]);
    expect(r.unanswerable.map((x) => x.key).sort()).toEqual(['t', 'y']);
  });
});

describe('AI mapper limits (M7 review)', () => {
  const ai = (out: unknown): Ai => (routedAi(['form-answers'], async () => out as never));
  it('never answers demographic questions or legal questions the rules left open, and needs evidence for options', async () => {
    const fields = [
      f('g', 'Gender identity', { kind: 'select', options: ['Male', 'Female', 'Non-binary'] }),
      f('race', 'race_q', { kind: 'radio', options: ['Asian', 'White / Caucasian', 'Black'] }),
      f('sp', 'Do you require sponsorship?', { kind: 'select', options: ['Yes', 'No'] }),
      f('c', 'Do you hold an active TS/SCI clearance?', { kind: 'select', options: ['Yes', 'No'] }),
      f('l', 'Preferred programming language', { kind: 'select', options: ['Go', 'Java'] }),
    ];
    const r = await mapWithAi(fields, profile(), ai({ answers: [
      { key: 'g', answer: 'Female', source: 'personal.fullName', evidence: 'Asha' },
      { key: 'race', answer: 'Asian', source: 'personal.location', evidence: 'Pune' },
      { key: 'sp', answer: 'No', source: 'personal.location', evidence: 'Pune, India' },
      { key: 'c', answer: 'Yes', source: 'certifications', evidence: 'TS/SCI clearance' },
      { key: 'l', answer: 'Go', source: 'experience', evidence: 'Built Go services handling 2M requests a day' },
    ] }), { company: 'Acme', title: 'Engineer' });
    expect(r.map((a) => a.key)).toEqual(['l']);
  });
});

describe('AI answers must be supported by the profile (final review C1)', () => {
  const ai = (out: unknown): Ai => (routedAi(['form-answers'], async () => out as never));
  const lead = () => {
    const p = profile();
    p.yearsExperience = 3;
    p.experience[0].bullets.push({ id: 'b_team', text: 'Led a team of 6 engineers building React dashboards' });
    return assignIds(p);
  };
  const answer = async (field: FormField, a: { answer: string; source: string; evidence: string }) => (await mapWithAi([field], lead(), ai({ answers: [{ key: field.key, ...a }] }), { company: 'Acme', title: 'Engineer' }))[0]?.value ?? null;

  it('never turns another number in the profile into years with a skill the profile lacks', async () => {
    expect(await answer(f('k', 'How many years of experience do you have with Kubernetes? *', { required: true }), { answer: '6', source: 'experience', evidence: '' })).toBeNull();
  });

  it('years of experience can’t exceed the profile’s total', async () => {
    const q = f('y', 'How many years of professional experience do you have? *', { required: true });
    expect(await answer(q, { answer: '6', source: 'experience', evidence: '' })).toBeNull();
    expect(await answer(q, { answer: '3', source: 'yearsExperience', evidence: '' })).toBe('3');
  });

  it('a "yes" needs evidence about the question itself, and never for a skill the profile lacks', async () => {
    const yesNo = (label: string) => f('q', label, { kind: 'select', options: ['Yes', 'No'] });
    expect(await answer(yesNo('Do you have production experience with Kubernetes?'), { answer: 'Yes', source: 'experience', evidence: 'Backend Engineer' })).toBeNull();
    expect(await answer(yesNo('Are you comfortable working in a fast-paced startup?'), { answer: 'Yes', source: 'experience', evidence: 'Backend Engineer' })).toBeNull();
    expect(await answer(yesNo('Do you have experience building React dashboards?'), { answer: 'Yes', source: 'experience', evidence: 'Led a team of 6 engineers building React dashboards' })).toBe('Yes');
  });
});
