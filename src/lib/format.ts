const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const toMs = (v: Date | number) => (v instanceof Date ? v.getTime() : v);

export function formatWhen(value: Date | number | null | undefined, now: Date | number): string {
  if (value === null || value === undefined) return 'never';
  const diffSec = Math.round((toMs(value) - toMs(now)) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return diffSec > 0 ? 'in a few seconds' : 'just now';
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86_400), 'day');
}

/** Words in a location that already say the work mode (in the languages postings come in). */
const SAYS_MODE: Record<string, RegExp> = {
  remote: /remot|worldwide|anywhere|distance|télétravail|teletrabajo|home ?office|fernarbeit/i,
  hybrid: /hybrid|híbrid|hybride|ibrid/i,
  onsite: /on-?site|in office|vor ort|presencial|présentiel/i,
};

/** Whether a location already says the work mode ("Remoto" says remote). */
export const saysWorkMode = (location: string | null, workMode: string) => !!location && (SAYS_MODE[workMode] ?? new RegExp(workMode, 'i')).test(location);

/** "Remote", or "Berlin · hybrid", without saying "Remote · remote" (or "Remoto · remote"). */
export function placeOf(location: string | null, workMode: string | null, unknown = 'Location not stated'): string {
  const place = location?.trim() || unknown;
  return workMode && !saysWorkMode(place, workMode) ? `${place} · ${workMode}` : place;
}

/** "a, b, c and 2 more": a short list that says when it is cut. */
export function listSome(items: string[], max = 3): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');
}

/** "1 run", "2 runs" (or the plural given, e.g. "matches"). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Current time for server-rendered pages (kept out of component bodies for the React purity lint). */
export function requestTime(): number {
  return Date.now();
}

/**
 * `instanceof` is unreliable for errors crossing Next.js route bundles (a class can be loaded twice),
 * so server actions recognise expected errors by name.
 */
export function isNamedError(err: unknown, ...names: string[]): err is Error {
  return err instanceof Error && names.includes(err.name);
}

/** CV files the pickers accept (the server checks the content again): PDF, Word .docx and old .doc. */
export const CV_ACCEPT = '.pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword';
