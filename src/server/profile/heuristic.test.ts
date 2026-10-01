import { describe, expect, it } from 'vitest';
import { SYNTHETIC_CVS } from '../../../tests/fixtures/cvs/synthetic';
import { heuristicExtract, parseDateRange } from './heuristic';
import { ProfileDataSchema } from './model';

describe('heuristicExtract', () => {
  for (const cv of SYNTHETIC_CVS) {
    describe(cv.slug, () => {
      const p = heuristicExtract(cv.text, new Date('2026-10-01'));

      it('produces a valid profile', () => {
        expect(() => ProfileDataSchema.parse(p)).not.toThrow();
      });

      it('finds name, contact details and headline', () => {
        expect(p.personal.fullName).toBe(cv.expect.fullName);
        expect(p.personal.email).toBe(cv.expect.email);
        expect(p.personal.phone).toBe(cv.expect.phone);
        expect(p.headline).toBe(cv.expect.headline);
      });

      it('finds skills, employers and institutions', () => {
        const skills = p.skills.map((s) => s.name);
        for (const s of cv.expect.skills) expect(skills).toContain(s);
        expect(p.experience.map((e) => e.company)).toEqual(expect.arrayContaining(cv.expect.employers));
        expect(p.education.map((e) => e.institution)).toEqual(expect.arrayContaining(cv.expect.institutions));
      });

      if (cv.expect.linkedin) {
        it('finds the LinkedIn link', () => {
          expect(p.personal.links.map((l) => l.url)).toContain(cv.expect.linkedin);
        });
      }
    });
  }

  it('reads job dates, bullets and current roles', () => {
    const p = heuristicExtract(SYNTHETIC_CVS[0].text, new Date('2026-10-01'));
    const [first, second] = p.experience;
    expect(first).toMatchObject({ title: 'Senior Software Engineer', startDate: '2023-01', endDate: null, current: true, location: 'Bengaluru' });
    expect(first.bullets[0].text).toMatch(/^Built a multi-tenant billing dashboard/);
    expect(second).toMatchObject({ startDate: '2021-07', endDate: '2022-12', current: false });
    expect(p.yearsExperience).toBeCloseTo(5.3, 0);
  });

  it('leaves fields it cannot find empty instead of guessing', () => {
    const p = heuristicExtract('Just a line of text with no structure at all\nand another one', new Date());
    expect(p.personal.email).toBeNull();
    expect(p.personal.phone).toBeNull();
    expect(p.experience).toEqual([]);
    expect(p.application.expectedSalary).toBeNull();
  });
});

describe('parseDateRange', () => {
  it.each([
    ['Jan 2023 – Present', { start: '2023-01', end: null, current: true }],
    ['March 2020 - Present', { start: '2020-03', end: null, current: true }],
    ['2019 – 2021', { start: '2019', end: '2021', current: false }],
    ['(2021–present)', { start: '2021', end: null, current: true }],
    ['May 2024 - July 2024', { start: '2024-05', end: '2024-07', current: false }],
  ])('%s', (input, expected) => {
    expect(parseDateRange(input)?.range).toEqual(expected);
  });
});
