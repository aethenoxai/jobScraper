import { describe, expect, it } from 'vitest';
import { describeSlider, interpretSlider } from './slider';

describe('interpretSlider (OD-1)', () => {
  it('maps 70–200 to a 70–95 match threshold, never demanding a perfect match', () => {
    expect(interpretSlider(70).matchThreshold).toBe(70);
    expect(interpretSlider(100).matchThreshold).toBe(76);
    expect(interpretSlider(200).matchThreshold).toBe(95);
  });

  it('chooses the tailoring intensity by band', () => {
    expect(interpretSlider(70).tailoringIntensity).toBe('light');
    expect(interpretSlider(99).tailoringIntensity).toBe('light');
    expect(interpretSlider(100).tailoringIntensity).toBe('standard');
    expect(interpretSlider(149).tailoringIntensity).toBe('standard');
    expect(interpretSlider(150).tailoringIntensity).toBe('deep');
  });

  it('clamps out-of-range values', () => {
    expect(interpretSlider(10)).toEqual(interpretSlider(70));
    expect(interpretSlider(900)).toEqual(interpretSlider(200));
  });

  it('explains the setting in plain language', () => {
    expect(describeSlider(100)).toMatch(/76%/);
    expect(describeSlider(180)).toMatch(/deep/i);
  });
});
