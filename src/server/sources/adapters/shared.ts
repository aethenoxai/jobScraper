import { detectEmploymentType, detectWorkMode, htmlToText } from '../../jobs/normalize';
import { SourceError } from '../types';

export { detectEmploymentType, detectWorkMode, htmlToText };

/** Runs a source request and converts any failure into a SourceError. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw SourceError.from(err);
  }
}

export const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v).replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const joinNonEmpty = (parts: Array<string | null | undefined>, sep = ', ') => parts.filter((p) => p && p.trim()).join(sep) || null;

/** "acme-labs" → "Acme Labs" for sources that don't return a company name. */
export const prettySlug = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const slugSchemaMessage = 'Use the short name from the board URL, e.g. "gitlab" in boards.greenhouse.io/gitlab';

/**
 * The text without its last line when that line is a site's own footer. Only a short last line of a text with more
 * than one line is examined (footers are one short line; this also keeps the regex cheap).
 */
export function dropLastLine(text: string, footer: RegExp, maxLength = 300): string {
  const trimmed = text.trimEnd();
  const cut = trimmed.lastIndexOf('\n');
  const last = trimmed.slice(cut + 1).trim();
  return cut > 0 && last.length <= maxLength && footer.test(last) ? trimmed.slice(0, cut).trimEnd() : text;
}
