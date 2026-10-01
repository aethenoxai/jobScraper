import type { ProfileData } from '../../src/server/profile/model';
import type { SyntheticCv } from '../../tests/fixtures/cvs/synthetic';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.+]/g, '');
const digits = (s: string) => s.replace(/\D/g, '');

export function f1(tp: number, fp: number, fn: number): number {
  if (tp + fp + fn === 0) return 1;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Fields none of the synthetic CVs state; any value there is invented. */
export const MUST_STAY_EMPTY: Array<[string, (p: ProfileData) => unknown]> = [
  ['application.workAuthorization', (p) => p.application.workAuthorization],
  ['application.visaStatus', (p) => p.application.visaStatus],
  ['application.noticePeriod', (p) => p.application.noticePeriod],
  ['application.currentSalary', (p) => p.application.currentSalary],
  ['application.expectedSalary', (p) => p.application.expectedSalary],
  ['application.relocation', (p) => p.application.relocation],
  ['application.travel', (p) => p.application.travel],
  ['personal.timezone', (p) => p.personal.timezone],
];

export interface CvScore {
  tp: number;
  fp: number;
  fn: number;
  f1: number;
  misses: string[];
  hallucinations: string[];
}

/** Field-level scoring of one extraction against the facts a correct extraction must contain. */
export function scoreCvExtraction(expected: SyntheticCv['expect'], actual: ProfileData, cvText: string): CvScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const misses: string[] = [];
  const scalar = (name: string, exp: string | null, got: string | null, eq: (a: string, b: string) => boolean) => {
    if (exp === null && got === null) return;
    if (exp !== null && got !== null && eq(exp, got)) tp++;
    else {
      if (got !== null) fp++;
      if (exp !== null) {
        fn++;
        misses.push(`${name}: expected "${exp}", got "${got ?? '—'}"`);
      }
    }
  };
  scalar('fullName', expected.fullName, actual.personal.fullName, (a, b) => norm(a) === norm(b));
  scalar('email', expected.email, actual.personal.email, (a, b) => norm(a) === norm(b));
  scalar('phone', expected.phone, actual.personal.phone, (a, b) => digits(a).slice(-9) === digits(b).slice(-9));
  scalar('headline', expected.headline, actual.headline, (a, b) => norm(a) === norm(b));

  const list = (name: string, exp: string[], got: string[]) => {
    const g = new Set(got.map(norm));
    for (const e of exp) {
      if (g.has(norm(e))) tp++;
      else {
        fn++;
        misses.push(`${name}: missing "${e}"`);
      }
    }
  };
  list('skills', expected.skills, actual.skills.map((s) => s.name));
  list('employers', expected.employers, actual.experience.map((e) => e.company ?? ''));
  list('institutions', expected.institutions, actual.education.map((e) => e.institution ?? ''));

  const lower = cvText.toLowerCase();
  const hallucinations: string[] = [];
  if (actual.personal.email && !lower.includes(actual.personal.email.toLowerCase())) hallucinations.push(`email: ${actual.personal.email}`);
  if (actual.personal.phone && !digits(cvText).includes(digits(actual.personal.phone).slice(-9))) hallucinations.push(`phone: ${actual.personal.phone}`);
  for (const [name, get] of MUST_STAY_EMPTY) {
    const v = get(actual);
    if (v !== null && v !== undefined) hallucinations.push(`${name}: ${String(v)}`);
  }

  return { tp, fp, fn, f1: f1(tp, fp, fn), misses, hallucinations };
}
