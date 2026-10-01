import { describe, expect, it } from 'vitest';
import { assignIds, emptyProfile, type ProfileData } from '../profile/model';
import type { TailoredCv } from './model';
import { numbersIn, repairTailoredCv, validateTailoredCv } from './validate';

function profile(): ProfileData {
  const p = emptyProfile();
  p.headline = 'Full Stack Developer';
  p.previousTitles = ['Software Engineer'];
  p.yearsExperience = 4;
  p.summary = 'Developer who ships.';
  p.skills = ['React', 'Node.js', 'PostgreSQL'].map((name, i) => ({ id: `skl_${i}`, name, category: 'skill' as const }));
  p.experience = [
    { id: 'exp_a', title: 'Software Engineer', company: 'Fictional Labs', location: null, startDate: '2022-01', endDate: null, current: true, summary: null, bullets: [{ id: 'bul_1', text: 'Reduced API latency by 35% with caching' }, { id: 'bul_2', text: 'Built a React dashboard for 1,200 customers' }] },
    { id: 'exp_b', title: 'Intern', company: 'Imaginary Apps', location: null, startDate: '2021-01', endDate: '2021-12', current: false, summary: null, bullets: [{ id: 'bul_3', text: 'Wrote Node.js scripts' }] },
  ];
  p.education = [{ id: 'edu_1', institution: 'Example Uni', degree: 'B.Tech', field: null, startDate: null, endDate: null, grade: null }];
  return assignIds(p);
}

function cv(over: Partial<TailoredCv> = {}): TailoredCv {
  return {
    headline: 'Full Stack Developer',
    summary: 'Full stack developer with 4 years of React and Node.js experience.',
    skills: ['React', 'node.js', 'Postgres'],
    experience: [
      { id: 'exp_a', bullets: [{ text: 'Cut API latency by 35% by introducing caching', sources: ['bul_1'] }, { text: 'Delivered a React dashboard serving 1,200 customers', sources: ['bul_2'] }] },
      { id: 'exp_b', bullets: [{ text: 'Automated tasks with Node.js scripts', sources: ['bul_3'] }] },
    ],
    projects: [],
    education: ['edu_1'],
    certifications: [],
    languages: [],
    sectionOrder: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages'],
    targeted: [],
    intensity: 'standard',
    method: 'ai',
    ...over,
  };
}

const kinds = (c: TailoredCv) => validateTailoredCv(c, profile()).map((v) => v.kind);

describe('validateTailoredCv', () => {
  it('accepts a CV that only rewords grounded facts (skill aliases allowed)', () => {
    expect(validateTailoredCv(cv(), profile())).toEqual([]);
  });

  it('rejects invented numbers', () => {
    const c = cv();
    c.experience[0].bullets[0].text = 'Cut API latency by 60% by introducing caching';
    expect(kinds(c)).toEqual(['number']);
  });

  it('rejects bullets without sources or citing another job', () => {
    const c = cv();
    c.experience[0].bullets[0].sources = [];
    c.experience[1].bullets[0].sources = ['bul_1'];
    expect(kinds(c).sort()).toEqual(['foreign-source', 'no-source']);
  });

  it('rejects skills and technologies the profile does not have', () => {
    const c = cv({ skills: ['React', 'Kubernetes'] });
    c.experience[0].bullets[1].text = 'Delivered a React and Kubernetes dashboard serving 1,200 customers';
    expect(kinds(c).sort()).toEqual(['skill', 'skill']);
  });

  it('rejects unknown ids, missing jobs, invented titles and inflated years', () => {
    const c = cv({ headline: 'Engineering Manager', summary: 'Engineer with 9 years of experience.', education: ['edu_x'] });
    c.experience = c.experience.slice(0, 1);
    expect(kinds(c).sort()).toEqual(['headline', 'missing-education', 'missing-experience', 'unknown-id', 'years']);
  });

  it('rejects employers in the summary that are not in the profile', () => {
    expect(kinds(cv({ summary: 'Previously a developer at Google and Fictional Labs.' }))).toEqual(['employer']);
  });
});

describe('repairTailoredCv', () => {
  it('reverts every violation to master data so the result is valid', () => {
    const c = cv({ headline: 'CTO', skills: ['React', 'Kubernetes'], summary: 'Leader with 12 years at Google.', education: ['edu_x'] });
    c.experience[0].bullets[0].text = 'Cut latency by 90%';
    c.experience[1].bullets[0].sources = [];
    c.experience = c.experience.slice(0, 2);
    const fixed = repairTailoredCv(c, profile(), 'Fallback summary.');
    expect(validateTailoredCv(fixed, profile())).toEqual([]);
    expect(fixed.headline).toBe('Full Stack Developer');
    expect(fixed.skills).toEqual(['React']);
    expect(fixed.summary).toBe('Fallback summary.');
    expect(fixed.experience[0].bullets[0]).toEqual({ text: 'Reduced API latency by 35% with caching', sources: ['bul_1'] });
    expect(fixed.experience[1].bullets).toEqual([]);
    // Unknown entries are dropped and the profile's degrees restored.
    expect(fixed.education).toEqual(['edu_1']);
  });

  it('restores jobs the tailored CV left out', () => {
    const c = cv();
    c.experience = c.experience.slice(0, 1);
    const fixed = repairTailoredCv(c, profile(), null);
    expect(fixed.experience.map((e) => e.id)).toEqual(['exp_a', 'exp_b']);
  });
});

describe('numbersIn', () => {
  it('reads units only when they are part of the number, not the next word', () => {
    expect(numbersIn('Grew ARR to $2.1M and cut costs 35 % in 10x less time')).toEqual(['$2.1m', '35%', '10x']);
    expect(numbersIn('5\nBuilt services for 3 brands')).toEqual(['5', '3']);
    expect(numbersIn('2M requests')).toEqual(['2m']);
  });
});

describe('validator catches fabrications (M5 review)', () => {
  const messages = (c: TailoredCv, p = profile()) => validateTailoredCv(c, p).map((v) => `${v.kind}: ${v.message}`).join(' | ');

  it('checks numbers and years in the summary, including spelled-out claims', () => {
    expect(messages(cv({ summary: 'Developer who cut cloud costs by 60% and saved $2M.' }))).toMatch(/number/);
    for (const summary of ['A 15-year career in web development.', 'Over a decade of experience.', 'Fifteen years of experience building products.']) {
      expect(messages(cv({ summary }))).toMatch(/years/);
    }
    const p = profile();
    p.yearsExperience = 4.1;
    expect(messages(cv({ summary: 'Developer with 5 years of experience.' }), p)).toMatch(/years/);
  });

  it("allows the profile's own summary as written", () => {
    const p = profile();
    p.summary = 'Developer with 5+ years who ships, ex-Fictional Labs.';
    expect(messages(cv({ summary: p.summary }), p)).toBe('');
  });

  it('catches spelled-out quantities and multipliers not in the cited line', () => {
    const c = cv();
    c.experience[0].bullets[0].text = 'Tripled API throughput with caching';
    expect(messages(c)).toMatch(/tripled/i);
    c.experience[0].bullets[0].text = 'Halved API latency with caching, used by millions';
    expect(messages(c)).toMatch(/halved|millions/i);
  });

  it("catches a skill credited to a role that didn't use it", () => {
    const c = cv();
    c.experience[1].bullets[0].text = 'Wrote Node.js scripts that loaded data into PostgreSQL';
    expect(messages(c)).toMatch(/PostgreSQL/);
  });

  it('catches client and employer names that are not in the cited line', () => {
    const c = cv();
    c.experience[0].bullets[1].text = 'Built a React dashboard for Google serving 1,200 customers';
    expect(messages(c)).toMatch(/Google/);
    expect(messages(cv({ summary: 'Ex-Netflix full stack developer.' }))).toMatch(/Netflix/);
  });

  it('requires a bullet to cite a line of the CV, not just the job', () => {
    const c = cv();
    c.experience[0].bullets[0].sources = ['exp_a'];
    expect(messages(c)).toMatch(/no-source/);
  });

  it('catches dropped or duplicated sections and dropped degrees', () => {
    expect(messages(cv({ sectionOrder: ['summary', 'skills'] }))).toMatch(/section/);
    expect(messages(cv({ sectionOrder: ['summary', 'skills', 'experience', 'experience', 'education'] }))).toMatch(/section/);
    expect(messages(cv({ education: [] }))).toMatch(/missing-education/);
  });

  it('allows only titles the user has held as the headline', () => {
    const p = profile();
    p.targetTitles = ['Engineering Manager'];
    expect(messages(cv({ headline: 'Engineering Manager' }), p)).toMatch(/headline/);
    expect(messages(cv({ headline: 'Software Engineer' }), p)).toBe('');
  });

  it('repairs all of these back to grounded master data', () => {
    const p = profile();
    const bad = cv({ summary: 'Over a decade of experience at Google.', sectionOrder: ['summary'], education: [] });
    bad.experience[0].bullets[0].text = 'Tripled throughput';
    const fixed = repairTailoredCv(bad, p, null);
    expect(validateTailoredCv(fixed, p)).toEqual([]);
    expect(fixed.sectionOrder).toEqual(expect.arrayContaining(['experience', 'education']));
  });
});

describe('validator allows normal edits (M5 review I8)', () => {
  it('does not read digits inside names like K8s, EC2 or p95 as claims', () => {
    const c = cv();
    c.experience[0].bullets[1].text = 'Built a React dashboard on EC2 and S3 for 1,200 customers';
    expect(validateTailoredCv(c, profile())).toEqual([]);
  });

  it('treats "35 percent" like "35%"', () => {
    const c = cv();
    c.experience[0].bullets[0].text = 'Cut API latency by 35 percent with caching';
    expect(validateTailoredCv(c, profile())).toEqual([]);
  });

  it('does not take "Fortune 500 clients" for an employer', () => {
    const p = profile();
    p.experience[0].bullets.push({ id: 'bul_9', text: 'Supported Fortune 500 clients' });
    expect(validateTailoredCv(cv({ summary: 'Full stack developer working with Fortune 500 clients.' }), p).map((v) => v.message)).toEqual([]);
  });
});

describe('numbers written as words count as numbers (final review I5)', () => {
  it('reads spelled-out numbers like digits, so they need the same backing', () => {
    expect(numbersIn('Mentored five junior developers')).toEqual(['5']);
    expect(numbersIn('Cut costs by forty percent')).toEqual(['40%']);
    expect(numbersIn('Used by twenty-five teams and a dozen partners')).toEqual(['25', '12']);
    // "one" is ordinary language far more often than a claim.
    expect(numbersIn('One of the first engineers')).toEqual([]);
    expect(numbersIn('Often shipped; tenure of note')).toEqual([]);
  });
});

describe('fractional years of experience (final review I6)', () => {
  it('the offline summary and letter say "over N years", and the validators accept them and the exact figure', async () => {
    const { offlineTailor } = await import('./offline');
    const { offlineCoverLetter, validateCoverLetter } = await import('./cover-letter');
    const { heuristicAnalysis } = await import('../matching/analysis');
    const p = profile();
    p.yearsExperience = 4.4;
    p.summary = null;
    p.headline = 'Backend Engineer';
    const analysis = heuristicAnalysis('Backend Engineer', 'Requirements\n• Go\n• PostgreSQL');
    const tailored = offlineTailor(p, analysis, 'standard');
    expect(tailored.summary).toMatch(/over 4 years of experience/);
    expect(validateTailoredCv(tailored, p)).toEqual([]);
    expect(validateTailoredCv({ ...tailored, summary: 'Backend engineer with 4.4 years of experience.' }, p)).toEqual([]);
    expect(validateTailoredCv({ ...tailored, summary: 'Backend engineer with 5 years of experience.' }, p).map((v) => v.message).join('\n')).toMatch(/years/);
    const letter = offlineCoverLetter(p, analysis, { title: 'Backend Engineer', company: 'Acme', description: '' });
    expect(letter.paragraphs.join(' ')).toMatch(/over 4 years of experience/);
    expect(validateCoverLetter(letter, p, { title: 'Backend Engineer', company: 'Acme', description: '' })).toEqual([]);
  });
});

describe('the user’s own wording in an edited summary (final review, new-user #2)', () => {
  it('accepts a skill the profile mentions anywhere (e.g. its own summary), not only in the skills list', () => {
    const p = profile();
    p.summary = 'Full stack developer with 4 years of experience building SaaS products with React and Node.js.';
    const c = cv({ summary: 'Full stack developer building SaaS products with React and Node.js.' });
    expect(validateTailoredCv(c, p).filter((v) => v.path === 'summary')).toEqual([]);
    expect(validateTailoredCv(cv({ summary: 'Full stack developer building Kubernetes platforms.' }), p).map((v) => v.message).join(' ')).toMatch(/Kubernetes/);
  });
});

describe('each entry appears once (final review, core minor)', () => {
  it('rejects a job, project, degree or language listed twice, and repair keeps one of each', () => {
    const p = profile();
    p.projects = [{ id: 'prj_1', name: 'Side project', description: null, url: null, technologies: [], bullets: [{ id: 'bul_p', text: 'Built a React app' }] }];
    const twice = cv({
      experience: [...cv().experience, { id: 'exp_a', bullets: [{ text: 'Reduced API latency by 35% with caching', sources: ['bul_1'] }] }],
      projects: [{ id: 'prj_1', bullets: [] }, { id: 'prj_1', bullets: [] }],
      education: ['edu_1', 'edu_1'],
    });
    const found = validateTailoredCv(twice, p).filter((v) => v.kind === 'duplicate').map((v) => v.path);
    expect(found.sort()).toEqual(['education.edu_1', 'experience.2', 'projects.1']);
    const fixed = repairTailoredCv(twice, p, null);
    expect(fixed.experience.map((e) => e.id)).toEqual(['exp_a', 'exp_b']);
    expect(fixed.projects.map((x) => x.id)).toEqual(['prj_1']);
    expect(fixed.education).toEqual(['edu_1']);
    expect(validateTailoredCv(fixed, p)).toEqual([]);
  });
});
