import { describe, expect, it } from 'vitest';
import { findSkills } from './vocabulary';

describe('findSkills', () => {
  it('finds very short skill names used as skills', () => {
    expect(findSkills('Experience with Go and C++')).toEqual(expect.arrayContaining(['Go', 'C++']));
    expect(findSkills('Languages: C, R, Go.')).toEqual(expect.arrayContaining(['Go', 'C', 'R']));
    expect(findSkills('• Go')).toEqual(['Go']);
    expect(findSkills('Strong R skills')).toEqual(['R']);
  });

  it('ignores short names that are part of everyday phrases', () => {
    expect(findSkills('Own our Go-to-market strategy')).not.toContain('Go');
    expect(findSkills('Go above and beyond for customers')).not.toContain('Go');
    expect(findSkills('A Series C startup with an R&D team reporting to the C-suite')).toEqual([]);
    expect(findSkills('Vitamin C research, Plan B')).toEqual([]);
  });
});
