/**
 * OD-1: meaning of the 70–200% matching/tailoring slider (PRD §14.1).
 * Every consumer goes through this one function so the semantics can change in one place.
 */
export type TailoringIntensity = 'light' | 'standard' | 'deep';

export interface SliderMeaning {
  value: number;
  /** Minimum match score (0–100) for a job to be shown. */
  matchThreshold: number;
  tailoringIntensity: TailoringIntensity;
}

export const SLIDER_RANGE = { min: 70, max: 200 } as const;

export function interpretSlider(raw: number): SliderMeaning {
  const value = Math.min(SLIDER_RANGE.max, Math.max(SLIDER_RANGE.min, Math.round(raw)));
  const matchThreshold = Math.round(70 + ((value - 70) * 25) / 130);
  const tailoringIntensity: TailoringIntensity = value < 100 ? 'light' : value < 150 ? 'standard' : 'deep';
  return { value, matchThreshold, tailoringIntensity };
}

const INTENSITY_TEXT: Record<TailoringIntensity, string> = {
  light: 'light CV tailoring (reorder and refocus)',
  standard: 'standard CV tailoring (rewritten bullets and matching terminology)',
  deep: 'deep CV tailoring (restructured to mirror each job’s requirements)',
};

export function describeSlider(raw: number): string {
  const m = interpretSlider(raw);
  return `Show jobs matching ${m.matchThreshold}% or more of their requirements · ${INTENSITY_TEXT[m.tailoringIntensity]}. Your CV is never padded with things you haven't done.`;
}
