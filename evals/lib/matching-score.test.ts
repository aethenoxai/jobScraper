import { describe, expect, it } from 'vitest';
import { precisionRecall } from './matching-score';

describe('precisionRecall', () => {
  it('computes precision and recall of surfaced jobs', () => {
    const r = precisionRecall([
      { expected: true, surfaced: true },
      { expected: true, surfaced: false },
      { expected: false, surfaced: true },
      { expected: false, surfaced: false },
    ]);
    expect(r).toEqual({ precision: 0.5, recall: 0.5, tp: 1, fp: 1, fn: 1, tn: 1 });
  });

  it('treats "nothing surfaced" as perfect precision', () => {
    expect(precisionRecall([{ expected: true, surfaced: false }]).precision).toBe(1);
  });
});
