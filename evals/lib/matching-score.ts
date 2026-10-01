export interface Judged {
  expected: boolean;
  surfaced: boolean;
}

export function precisionRecall(rows: Judged[]) {
  const tp = rows.filter((r) => r.expected && r.surfaced).length;
  const fp = rows.filter((r) => !r.expected && r.surfaced).length;
  const fn = rows.filter((r) => r.expected && !r.surfaced).length;
  const tn = rows.filter((r) => !r.expected && !r.surfaced).length;
  return { precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn), tp, fp, fn, tn };
}
