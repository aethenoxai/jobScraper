/** Stands in for the address of a job the user pasted without a link (listings need one). It is never shown. */
export const PASTED_URL = 'https://job-scraper.local/pasted';

/** Whether a job's address leads anywhere (false for jobs pasted without a link). */
export const hasRealLink = (url: string | null | undefined): url is string => !!url && !url.startsWith(PASTED_URL);

/** Sites Job Scraper never reads or automates (their terms forbid it, or they block automation). */
export const NEVER_FETCH = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|naukri\.com|monster\.[a-z.]+|ziprecruiter\.com|simplyhired\.[a-z.]+|foundit\.in|shine\.com|facebook\.com|x\.com|twitter\.com)$/i;

/** The site's name ("linkedin.com") when Job Scraper won't apply there for the user, otherwise null. */
export function notAutomated(url: string | null | undefined): string | null {
  if (!hasRealLink(url) || !URL.canParse(url)) return null;
  const host = new URL(url).hostname;
  return NEVER_FETCH.test(host) ? host.replace(/^www\./, '') : null;
}

/** The source that holds jobs the user added by link or pasted. */
export const MANUAL_SOURCE_NAME = 'Added by you';

/** Where a listing is from, as shown to the user: the site's name for a job they added ("acme.com"), else the source. */
export function sourceLabel(sourceName: string, url: string | null | undefined): string {
  if (sourceName !== MANUAL_SOURCE_NAME) return sourceName;
  return hasRealLink(url) && URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, '') : 'a job you pasted';
}
