/**
 * Deterministic match score (PLAN §2.8). The AI (or the offline evaluator) judges requirements;
 * the arithmetic lives here so it is explainable and testable.
 */
import type { ProfileData } from '../profile/model';
import { seniorityOf, type JobRequirements } from './analysis';
import type { Evaluation, RequirementEvaluation } from './evaluate';
import { interpretSlider } from './slider';

type Seniority = NonNullable<JobRequirements['seniority']>;
const RANK: Record<Seniority, number> = { intern: 0, entry: 1, junior: 1, mid: 2, senior: 3, lead: 4, manager: 4, director: 5, executive: 6 };
/** Jobs this many levels above or below the user stay below the usual thresholds. */
const SENIORITY_CAP = 65;

/** The user's level: from their current (or latest) job title, else from their years of experience. */
export function profileSeniority(p: ProfileData): Seniority | null {
  const latest = p.experience.find((e) => e.current) ?? p.experience[0];
  return (latest?.title ? seniorityOf(latest.title, null) : null) ?? seniorityOf('', p.yearsExperience);
}

/** Levels between the job and the user: positive when the job is more senior. */
export function seniorityGap(job: Seniority | null, user: Seniority | null): number | null {
  return job && user ? RANK[job] - RANK[user] : null;
}

export const WEIGHTS = { mustHave: 40, role: 15, skills: 15, experience: 10, location: 10, other: 10 } as const;
/** A clearly unmet hard requirement (licence, language, work permit) caps the score here. */
export const HARD_CAP = 60;
const HARD_KINDS = new Set(['certification', 'language', 'authorization']);

export interface ScoreInput {
  evaluation: Evaluation;
  yearsRequired: number | null;
  profileYears: number | null;
  /** From the location gate: 1 exact, 0.8 same country, 0.6 unknown. */
  locationFit: number;
  /** 1 unless the job's maximum salary is below the user's minimum. */
  salaryFit: number;
  /** From seniorityGap(): levels the job is above (+) or below (−) the user. */
  seniorityGap?: number | null;
}

export interface ScoreResult {
  score: number;
  components: Record<keyof typeof WEIGHTS, number>;
  cappedBy: string | null;
  /** What the cap was: an unmet hard requirement (cappedBy is its text) or a seniority gap (cappedBy explains it). */
  capKind?: 'requirement' | 'seniority';
}

const credit = (r: RequirementEvaluation) => (r.status === 'met' ? 1 : r.status === 'partial' ? 0.5 : 0);
const coverage = (reqs: RequirementEvaluation[]) => (reqs.length ? reqs.reduce((a, r) => a + credit(r), 0) / reqs.length : null);

export function computeScore(input: ScoreInput): ScoreResult {
  const reqs = input.evaluation.requirements;
  const mandatory = reqs.filter((r) => r.mandatory);
  const optional = reqs.filter((r) => !r.mandatory);
  const skillReqs = reqs.filter((r) => r.kind === 'skill');
  const otherReqs = reqs.filter((r) => ['education', 'certification', 'language'].includes(r.kind));

  // Nothing readable in the posting (short or truncated descriptions): judge it on the title instead of treating
  // every requirement as half met, which kept even exact title matches below the default threshold.
  const roleFit = Math.max(0, Math.min(1, input.evaluation.roleFit));
  const unread = reqs.length === 0 ? 0.5 + 0.15 * roleFit : 0.5;
  const mustHave = coverage(mandatory) ?? coverage(optional) ?? unread;
  const skills = coverage(skillReqs) ?? mustHave;
  const gap = Math.abs(input.seniorityGap ?? 0);
  let experience =
    input.yearsRequired === null || input.yearsRequired === 0 ? 1 : input.profileYears === null ? 0.5 : Math.min(1, input.profileYears / input.yearsRequired);
  if (gap === 2) experience = Math.min(experience, 0.4);
  const otherParts = [coverage(otherReqs), input.salaryFit].filter((x): x is number => x !== null);
  const other = otherParts.reduce((a, b) => a + b, 0) / otherParts.length;
  const components = {
    mustHave,
    role: roleFit,
    skills,
    experience,
    location: input.locationFit,
    other,
  };
  let score = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * components[k as keyof typeof WEIGHTS], 0));
  let cappedBy: string | null = null;
  let capKind: ScoreResult['capKind'];
  const hard = mandatory.find((r) => HARD_KINDS.has(r.kind) && r.status === 'unmet');
  if (hard) {
    score = Math.min(score, HARD_CAP);
    cappedBy = hard.text;
    capKind = 'requirement';
  }
  if (gap >= 3 && score > SENIORITY_CAP && !hard) {
    score = SENIORITY_CAP;
    cappedBy = (input.seniorityGap ?? 0) > 0 ? 'The job is several levels above your experience' : 'The job is several levels below your experience';
    capKind = 'seniority';
  }
  return { score, components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v * 100) / 100])) as ScoreResult['components'], cappedBy, ...(capKind ? { capKind } : {}) };
}

export function decide(score: number, sliderValue: number): { decision: 'surfaced' | 'filtered'; threshold: number; reason?: string } {
  const { matchThreshold } = interpretSlider(sliderValue);
  return score >= matchThreshold
    ? { decision: 'surfaced', threshold: matchThreshold }
    : { decision: 'filtered', threshold: matchThreshold, reason: `Match ${score}% is below your ${matchThreshold}% threshold` };
}
