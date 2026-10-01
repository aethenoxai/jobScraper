import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import type { Ai, AiStatus } from '../ai';
import { jobAnalyses } from '../db/schema';
import { analyzeJob, heuristicAnalysis, type JobRequirements } from './analysis';

const JD = `About us
We build payments software.

What you'll do
• Design APIs
• Mentor engineers

Requirements
• 5+ years of experience building backend services
• Strong Go or Java skills
• Experience with PostgreSQL and Kafka
• Bachelor's degree in Computer Science or equivalent
• Right to work in the UK

Nice to have
• Kubernetes
• Fluent German

To apply, send your CV to jobs@acme.example.`;

describe('heuristicAnalysis', () => {
  const a = heuristicAnalysis('Senior Backend Engineer', JD);

  it('reads must-haves and nice-to-haves from their sections', () => {
    const must = a.requirements.filter((r) => r.mandatory).map((r) => r.text);
    const nice = a.requirements.filter((r) => !r.mandatory).map((r) => r.text);
    expect(must).toContain('Strong Go or Java skills');
    expect(must).not.toContain('Design APIs');
    expect(nice).toEqual(['Kubernetes', 'Fluent German']);
  });

  it('classifies requirement kinds', () => {
    const kind = (t: string) => a.requirements.find((r) => r.text.startsWith(t))?.kind;
    expect(kind('5+ years')).toBe('experience');
    expect(kind("Bachelor's")).toBe('education');
    expect(kind('Right to work')).toBe('authorization');
    expect(kind('Fluent German')).toBe('language');
    expect(kind('Experience with PostgreSQL')).toBe('skill');
    expect(heuristicAnalysis('Teacher', 'Requirements\n• Teaching qualification').requirements[0].kind).toBe('certification');
  });

  it('finds minimum years, seniority, skills and the apply email', () => {
    expect(a).toMatchObject({ yearsExperienceMin: 5, seniority: 'senior', applyEmail: 'jobs@acme.example' });
    expect(a.skills).toEqual(expect.arrayContaining(['Go', 'Java', 'PostgreSQL', 'Kafka', 'Kubernetes']));
  });

  it('falls back to skills mentioned anywhere when there are no requirement sections', () => {
    const b = heuristicAnalysis('Data Analyst', 'You will use SQL, Python and Tableau to build dashboards.');
    expect(b.requirements.map((r) => r.text)).toEqual(expect.arrayContaining(['SQL', 'Python', 'Tableau']));
  });
});

describe('analyzeJob', () => {
  let t: ReturnType<typeof createTempDb>;
  beforeEach(() => (t = createTempDb()));
  afterEach(() => t.cleanup());

  const aiReturning = (out: JobRequirements, calls: { n: number }): Ai => ({
    status: () => ({ configured: true }) as AiStatus,
    generateObject: async () => {
      calls.n++;
      return out as never;
    },
  });

  it('caches per description and drops requirements the AI invented', async () => {
    const calls = { n: 0 };
    const ai = aiReturning(
      { requirements: [{ text: 'Strong Go skills', kind: 'skill', mandatory: true }, { text: 'Security clearance', kind: 'authorization', mandatory: true }], yearsExperienceMin: 5, seniority: 'senior', summary: null, applyEmail: null, skills: ['Go'] },
      calls,
    );
    const listing = { title: 'Senior Backend Engineer', description: JD, descriptionHash: 'h1' };
    const first = await analyzeJob(listing, { db: t.db, ai });
    const second = await analyzeJob(listing, { db: t.db, ai });
    expect(calls.n).toBe(1);
    expect(first.method).toBe('ai');
    expect(first.requirements.map((r) => r.text)).toEqual(['Strong Go skills']);
    expect(second).toEqual(first);
    expect(t.db.select().from(jobAnalyses).all()).toHaveLength(1);
  });

  it('uses the offline analysis when AI fails, and upgrades later', async () => {
    const listing = { title: 'Senior Backend Engineer', description: JD, descriptionHash: 'h2' };
    const broken: Ai = { status: () => ({ configured: true }) as AiStatus, generateObject: async () => { throw new Error('quota'); } };
    expect((await analyzeJob(listing, { db: t.db, ai: broken })).method).toBe('heuristic');
    const calls = { n: 0 };
    const ok = aiReturning({ requirements: [{ text: 'Kafka', kind: 'skill', mandatory: true }], yearsExperienceMin: null, seniority: null, summary: null, applyEmail: null, skills: [] }, calls);
    expect((await analyzeJob(listing, { db: t.db, ai: ok })).method).toBe('ai');
  });
});
