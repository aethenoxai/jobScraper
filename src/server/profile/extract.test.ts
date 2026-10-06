import { describe, expect, it } from 'vitest';
import { SYNTHETIC_CVS } from '../../../tests/fixtures/cvs/synthetic';
import type { Ai } from '../ai';
import { fakeRoutes } from '../ai/fake';
import { registerSecret } from '../logging';
import { AiExtractionSchema, extractProfile, type AiExtraction } from './extract';

const cv = SYNTHETIC_CVS[0]; // Asha Rao, software engineer

function fakeAi(output: AiExtraction | Error): Ai {
  return {
    ...fakeRoutes(['cv-extract']),
    generateObject: async () => {
      if (output instanceof Error) throw output;
      return output as never;
    },
  };
}

function aiOutput(overrides: Partial<AiExtraction> = {}): AiExtraction {
  const base = AiExtractionSchema.parse({
    personal: { fullName: 'Asha Rao', email: 'asha.rao@example.com', phone: '+919876543210', location: 'Bengaluru, India', country: 'India', timezone: null, links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/asha-rao-example' }] },
    headline: 'Full Stack Developer',
    previousTitles: ['Software Engineer'],
    summary: 'Full stack developer with 4 years of experience.',
    industry: 'Software',
    domain: 'SaaS',
    yearsExperience: 4,
    careerLevel: 'mid',
    experience: [{ title: 'Senior Software Engineer', company: 'Fictional Labs Pvt Ltd', location: 'Bengaluru', startDate: 'Jan 2023', endDate: null, current: true, summary: null, bullets: ['Built a multi-tenant billing dashboard'] }],
    education: [{ institution: 'Example Institute of Technology', degree: 'B.Tech', field: 'Computer Science', startDate: '2017', endDate: '2021', grade: null }],
    certifications: [],
    skills: [{ name: 'React', category: 'technology' }],
    projects: [],
    languages: [{ name: 'English', proficiency: 'Fluent' }],
    application: { workAuthorization: null, visaStatus: null, noticePeriod: null, relocation: null, travel: null, currentlyEmployed: true, currentSalary: null, expectedSalary: null },
  });
  return { ...base, ...overrides };
}

describe('extractProfile', () => {
  it('uses the offline extractor when no AI is available', async () => {
    const r = await extractProfile(cv.text, null);
    expect(r.method).toBe('heuristic');
    expect(r.data.personal.email).toBe('asha.rao@example.com');
  });

  it('uses AI output, normalising dates and assigning ids', async () => {
    const r = await extractProfile(cv.text, fakeAi(aiOutput()), { now: new Date('2026-10-01') });
    expect(r.method).toBe('ai');
    expect(r.data.experience[0]).toMatchObject({ startDate: '2023-01', current: true });
    expect(r.data.experience[0].id).toMatch(/^exp_/);
    expect(r.data.experience[0].bullets[0].id).toMatch(/^bul_/);
  });

  it('drops contact details that do not appear in the CV (no fabrication)', async () => {
    const out = aiOutput();
    out.personal = { ...out.personal, email: 'invented@nowhere.test', phone: '+1 555 000 1111', links: [{ label: 'Site', url: 'https://made-up.example' }, ...out.personal.links] };
    const r = await extractProfile(cv.text, fakeAi(out));
    expect(r.data.personal.email).toBeNull();
    expect(r.data.personal.phone).toBeNull();
    expect(r.data.personal.links.map((l) => l.url)).toEqual(['https://www.linkedin.com/in/asha-rao-example']);
    expect(r.warnings.join(' ')).toMatch(/not found in the CV/);
  });

  it('keeps a phone number the AI reformatted', async () => {
    const r = await extractProfile(cv.text, fakeAi(aiOutput()));
    expect(r.data.personal.phone).toBe('+919876543210');
  });

  it('prefers years computed from job dates over the AI estimate', async () => {
    const out = aiOutput({ yearsExperience: 12 });
    const r = await extractProfile(cv.text, fakeAi(out), { now: new Date('2026-10-01') });
    expect(r.data.yearsExperience).toBeCloseTo(3.8, 0);
  });

  it('when the AI is set up but fails, says so instead of falling back to fixed rules', async () => {
    await expect(extractProfile(cv.text, fakeAi(new Error('rate limited')))).rejects.toThrow(/AI couldn.t read your CV: rate limited/);
  });

  it('keeps the provider’s reason visible when the error carries the route prefix', async () => {
    const reason = 'The model said: ' + 'x'.repeat(120);
    await expect(extractProfile(cv.text, fakeAi(new Error(`cv-extract · openai · gpt-5-mini: ${reason}`)))).rejects.toThrow(`The AI couldn’t read your CV: ${reason}`);
  });

  it('reads the CV offline when only other tasks have a provider', async () => {
    const other: Ai = { ...fakeRoutes(['jd-analysis']), generateObject: async () => { throw new Error('must not be called'); } };
    expect((await extractProfile(cv.text, other)).method).toBe('heuristic');
  });

  it('gives the model the original document as well as its text', async () => {
    const seen: Array<{ file?: { mediaType: string }; prompt: string }> = [];
    const ai: Ai = { ...fakeRoutes(['cv-extract']), generateObject: async (req) => (seen.push(req), aiOutput() as never) };
    const file = { data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf' };
    await extractProfile(cv.text, ai, { file });
    expect(seen[0].file).toBe(file);
    expect(seen[0].prompt).toContain('asha.rao@example.com');
  });

  it('removes application details, time zone and country the CV does not state', async () => {
    const out = aiOutput();
    out.personal = { ...out.personal, timezone: 'Asia/Kolkata', country: 'Germany' };
    out.application = { workAuthorization: 'Indian citizen', visaStatus: 'None required', noticePeriod: 'Immediate', relocation: true, travel: false, currentlyEmployed: false, currentSalary: '₹10 LPA', expectedSalary: '₹15 LPA' };
    const r = await extractProfile(cv.text, fakeAi(out));
    expect(r.data.personal.timezone).toBeNull();
    expect(r.data.personal.country).toBeNull();
    expect(r.data.application).toEqual({ workAuthorization: null, visaStatus: null, noticePeriod: null, relocation: null, travel: null, currentlyEmployed: true, currentSalary: null, expectedSalary: null });
  });

  it('keeps application details the CV does state', async () => {
    const text = `${cv.text}\nNotice period: 30 days\nOpen to relocation within India\nExpected salary ₹18 LPA`;
    const out = aiOutput();
    out.application = { ...out.application, noticePeriod: '30 days', relocation: true, expectedSalary: '₹18 LPA' };
    const r = await extractProfile(text, fakeAi(out));
    expect(r.data.application).toMatchObject({ noticePeriod: '30 days', relocation: true, expectedSalary: '₹18 LPA' });
    expect(r.data.personal.country).toBe('India');
  });

  it('requires whole-URL evidence for links and project URLs', async () => {
    const out = aiOutput();
    out.personal = { ...out.personal, links: [{ label: 'GitHub', url: 'https://github.com' }, { label: 'GH', url: 'github.com/asharao-other-example' }, { label: 'GH', url: 'https://github.com/asharao-example' }] };
    out.projects = [{ name: 'Billing', description: null, url: 'https://github.com/asharao-example/billing', technologies: [], bullets: [] }];
    const r = await extractProfile(cv.text, fakeAi(out));
    expect(r.data.personal.links.map((l) => l.url)).toEqual(['https://github.com/asharao-example']);
    expect(r.data.projects[0].url).toBeNull();
  });

  it('scrubs secrets from AI error messages it shows the user', async () => {
    registerSecret('sk-very-secret-key-123');
    const err = await extractProfile(cv.text, fakeAi(new Error('401: invalid key sk-very-secret-key-123'))).catch((e: Error) => e);
    expect(String(err)).toMatch(/401/);
    expect(String(err)).not.toContain('sk-very-secret-key-123');
  });

  it('keeps links that end a sentence', async () => {
    const text = `${cv.text}\nPortfolio: janedoe.example. Code at github.com/janedoe-example.`;
    const out = aiOutput();
    out.personal = { ...out.personal, links: [{ label: 'Portfolio', url: 'https://janedoe.example' }, { label: 'GitHub', url: 'github.com/janedoe-example' }] };
    const r = await extractProfile(text, fakeAi(out));
    expect(r.data.personal.links.map((l) => l.url)).toEqual(['https://janedoe.example', 'github.com/janedoe-example']);
  });

  it('drops a link the AI cut short ("github.com/jane" from "github.com/jane.doe")', async () => {
    const text = `${cv.text}\nCode at github.com/jane.doe and gitlab.com/jane_x`;
    const out = aiOutput();
    out.personal = { ...out.personal, links: [{ label: 'GitHub', url: 'github.com/jane' }, { label: 'GitLab', url: 'gitlab.com/jane' }] };
    const r = await extractProfile(text, fakeAi(out));
    expect(r.data.personal.links).toEqual([]);
  });
});
