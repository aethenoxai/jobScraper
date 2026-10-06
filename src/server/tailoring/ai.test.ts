import { describe, expect, it } from 'vitest';
import type { Ai } from '../ai';
import { fakeRoutes } from '../ai/fake';
import type { JobRequirements } from '../matching/analysis';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import { tailorCv } from './ai';
import { validateTailoredCv } from './validate';

function profile(): ProfileData {
  const p = emptyProfile();
  p.headline = 'Full Stack Developer';
  p.yearsExperience = 4;
  p.skills = ['React', 'Node.js'].map((name, i) => ({ id: `skl_${i}`, name, category: 'skill' as const }));
  p.experience = [{ id: 'exp_a', title: 'Software Engineer', company: 'Fictional Labs', location: null, startDate: '2022-01', endDate: null, current: true, summary: null, bullets: [{ id: 'bul_1', text: 'Reduced Node.js API latency by 35% with caching' }] }];
  return assignIds(p);
}
const analysis: JobRequirements = { requirements: [{ text: 'Node.js', kind: 'skill', mandatory: true }], yearsExperienceMin: 3, seniority: 'mid', summary: null, applyEmail: null, skills: ['Node.js'] };
const job = { title: 'Backend Engineer', company: 'Acme' };

const good = { headline: 'Full Stack Developer', summary: 'Full stack developer with 4 years of Node.js experience.', skills: ['Node.js', 'React'], experience: [{ id: 'exp_a', bullets: [{ text: 'Cut Node.js API latency by 35% through caching', sources: ['bul_1'] }] }], projects: [], education: [], certifications: [], languages: [], sectionOrder: ['summary', 'skills', 'experience'], targeted: ['Node.js'] };
const bad = { ...good, skills: ['Node.js', 'Kubernetes'], experience: [{ id: 'exp_a', bullets: [{ text: 'Cut latency by 80%', sources: ['bul_1'] }] }] };

function fakeAi(outputs: unknown[], prompts: string[] = []): Ai {
  return {
    ...fakeRoutes(['cv-tailor']),
    generateObject: async (req) => {
      prompts.push(req.prompt);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next as never;
    },
  };
}

describe('tailorCv', () => {
  it('uses a grounded AI result as is', async () => {
    const r = await tailorCv({ profile: profile(), analysis, intensity: 'standard', job, ai: fakeAi([good]) });
    expect(r.cv.method).toBe('ai');
    expect(r.cv.experience[0].bullets[0].text).toMatch(/Node\.js API latency/);
    expect(r.repairs).toBe(0);
  });

  it('keeps the jobs in your order even when the model moves a more relevant job to the top (M5 deferred minor)', async () => {
    const p = profile();
    p.experience.push({ id: 'exp_b', title: 'Junior Developer', company: 'Old Co', location: null, startDate: '2019-01', endDate: '2021-12', current: false, summary: null, bullets: [{ id: 'bul_2', text: 'Built React dashboards' }] });
    const reordered = { ...good, experience: [{ id: 'exp_b', bullets: [{ text: 'Built React dashboards', sources: ['bul_2'] }] }, good.experience[0]] };
    const r = await tailorCv({ profile: p, analysis, intensity: 'standard', job, ai: fakeAi([reordered]) });
    expect(r.cv.experience.map((e) => e.id)).toEqual(['exp_a', 'exp_b']);
    expect(r.repairs).toBe(0);
  });

  it('asks the model once to fix violations, telling it what was wrong', async () => {
    const prompts: string[] = [];
    const r = await tailorCv({ profile: profile(), analysis, intensity: 'deep', job, ai: fakeAi([bad, good], prompts) });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/Kubernetes/);
    expect(validateTailoredCv(r.cv, profile())).toEqual([]);
    expect(r.repairs).toBe(0);
  });

  it('repairs deterministically when the model fails twice', async () => {
    const r = await tailorCv({ profile: profile(), analysis, intensity: 'deep', job, ai: fakeAi([bad, bad]) });
    expect(validateTailoredCv(r.cv, profile())).toEqual([]);
    expect(r.cv.experience[0].bullets[0].text).toBe('Reduced Node.js API latency by 35% with caching');
    expect(r.repairs).toBeGreaterThan(0);
  });

  it('falls back to offline tailoring when AI is unavailable or fails', async () => {
    expect((await tailorCv({ profile: profile(), analysis, intensity: 'standard', job, ai: null })).cv.method).toBe('offline');
    expect((await tailorCv({ profile: profile(), analysis, intensity: 'standard', job, ai: fakeAi([new Error('down')]) })).cv.method).toBe('offline');
  });

  it('reports how much the model got wrong first, and why it fell back to offline', async () => {
    const fixed = await tailorCv({ profile: profile(), analysis, intensity: 'standard', job, ai: fakeAi([bad, good]) });
    expect(fixed.firstPassViolations).toBeGreaterThan(0);
    expect(fixed.aiError).toBeUndefined();
    const failed = await tailorCv({ profile: profile(), analysis, intensity: 'standard', job, ai: fakeAi([new Error('Daily AI budget reached')]) });
    expect(failed.cv.method).toBe('offline');
    expect(failed.aiError).toMatch(/budget/);
  });
});
