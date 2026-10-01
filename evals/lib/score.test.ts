import { describe, expect, it } from 'vitest';
import { emptyProfile } from '../../src/server/profile/model';
import { f1, scoreCvExtraction } from './score';

describe('scoreCvExtraction', () => {
  const expected = { fullName: 'Asha Rao', email: 'a@x.com', phone: '+91 98765 43210', headline: 'Dev', skills: ['React', 'SQL'], employers: ['Acme'], institutions: ['IIT'] };
  const text = 'Asha Rao a@x.com +91 98765 43210 Dev React SQL Acme IIT';

  it('scores a perfect extraction as 1', () => {
    const p = emptyProfile();
    p.personal = { ...p.personal, fullName: 'Asha Rao', email: 'a@x.com', phone: '+919876543210' };
    p.headline = 'Dev';
    p.skills = [{ id: '1', name: 'react', category: 'skill' }, { id: '2', name: 'SQL', category: 'skill' }];
    p.experience = [{ id: 'e', title: 'Dev', company: 'Acme', location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [] }];
    p.education = [{ id: 'd', institution: 'IIT', degree: null, field: null, startDate: null, endDate: null, grade: null }];
    const s = scoreCvExtraction(expected, p, text);
    expect(s.f1).toBe(1);
    expect(s.hallucinations).toEqual([]);
  });

  it('penalises misses and counts hallucinated contact fields', () => {
    const p = emptyProfile();
    p.personal.fullName = 'Asha Rao';
    p.personal.email = 'made-up@nowhere.test';
    const s = scoreCvExtraction(expected, p, text);
    expect(s.f1).toBeLessThan(0.5);
    expect(s.hallucinations).toEqual(['email: made-up@nowhere.test']);
  });

  it('f1 handles zero cases', () => {
    expect(f1(0, 0, 0)).toBe(1);
    expect(f1(0, 1, 1)).toBe(0);
  });

  it('counts invented application details as hallucinations', () => {
    const p = emptyProfile();
    p.application.noticePeriod = 'Immediate';
    expect(scoreCvExtraction(expected, p, text).hallucinations).toEqual(['application.noticePeriod: Immediate']);
  });
});
