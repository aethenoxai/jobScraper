/**
 * Links an incoming email to the application it is about (PRD §32). Strongest evidence first: a reply to our own
 * application email; the company's own domain; an applicant-tracking system's mail that names the company; the
 * company and job title together. A company name alone (news, newsletters) is never enough, and a tie between
 * two applications stays unmatched rather than guessed.
 */
import { mentions } from '../matching/gates';

export interface IncomingMessage {
  from: string;
  fromName: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
}

export interface Candidate {
  id: number;
  company: string;
  jobTitle: string;
  applyEmail: string | null;
  applicationUrl: string | null;
  sourceUrl: string;
  /** Message-IDs of application emails sent for this application. */
  sentMessageIds: string[];
}

export interface MatchResult {
  applicationId: number;
  matchedBy: 'thread' | 'domain' | 'ats+company' | 'company+title';
  score: number;
}

/** Applicant-tracking systems and job boards: their domains say nothing about the employer. */
const PLATFORM = /(?:^|\.)(?:greenhouse(?:-mail)?\.io|lever\.co|ashbyhq\.com|workable(?:mail)?\.com|smartrecruiters\.com|myworkday(?:jobs)?\.com|icims\.com|jobvite\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|personio\.(?:de|com)|successfactors\.(?:com|eu)|taleo\.net|linkedin\.com|indeed\.com|glassdoor\.com|naukri\.com|monster\.com|ziprecruiter\.com|wellfound\.com|remoteok\.com|remotive\.com|himalayas\.app|arbeitnow\.com|adzuna\.[a-z.]+)$/i;
/** Personal mail providers: an apply address there identifies one sender, never the whole provider. */
const FREE_MAIL = /(?:^|\.)(?:gmail\.com|googlemail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|ymail\.com|rocketmail\.com|icloud\.com|me\.com|mac\.com|proton(?:mail)?\.(?:me|com|ch)|pm\.me|aol\.com|gmx\.[a-z.]+|web\.de|zoho(?:mail)?\.(?:com|in|eu)|yandex\.[a-z.]+|mail\.ru|rediff(?:mail)?\.com|qq\.com|163\.com|126\.com|sina\.com|fastmail\.(?:com|fm)|hey\.com|tuta(?:nota)?\.(?:com|de|io)|mail\.com|inbox\.com|libero\.it|orange\.fr|t-online\.de)$/i;
/** Hosts many unrelated organisations share (forms, code hosting, site builders): a job link there names no employer. */
const SHARED_HOST = /(?:^|\.)(?:google\.com|forms\.gle|goo\.gl|github\.com|github\.io|gitlab\.com|bitbucket\.org|notion\.(?:so|site)|typeform\.com|airtable\.com|office\.com|microsoft\.com|sharepoint\.com|live\.com|jotform\.com|tally\.so|wufoo\.com|surveymonkey\.com|hubspot\.com|hsforms\.com|wix(?:site)?\.com|squarespace\.com|wordpress\.com|medium\.com|substack\.com|bit\.ly|ycombinator\.com|reddit\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|t\.me|telegram\.org|wa\.me|whatsapp\.com|dropbox\.com|calendly\.com|zoom\.us|carrd\.co|webflow\.io|vercel\.app|netlify\.app|herokuapp\.com|pages\.dev|blogspot\.com|amazonaws\.com|cloudfront\.net|apple\.com)$/i;
/** Words that make a mail from the company's domain about recruiting, not news, billing or marketing. */
const RECRUITING_CUE = /\b(?:applications?|applied|applying|apply|candidate|candidacy|position|role|vacancy|opening|interview\w*|recruit\w*|hiring|talent|resume|cv|offer|next steps?|call|chat|schedule|availability|assessment|opportunity)\b/i;
const SECOND_LEVEL = new Set(['co', 'com', 'ac', 'gov', 'org', 'net', 'edu', 'ltd', 'plc']);

/** "jobs.acme.co.uk" → "acme.co.uk". */
export function siteDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  const keep = parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};
const emailDomain = (address: string | null) => (address?.includes('@') ? address.split('@')[1].toLowerCase().trim() : null);
const norm = (id: string) => id.trim().replace(/^<|>$/g, '').toLowerCase();
const isEmployerHost = (host: string) => !PLATFORM.test(host) && !FREE_MAIL.test(host) && !SHARED_HOST.test(host);

/** The domains that belong to the employer of an application (never a platform, mail provider or shared host). */
function companyDomains(c: Candidate): string[] {
  return [...new Set([emailDomain(c.applyEmail), hostOf(c.applicationUrl), hostOf(c.sourceUrl)].filter((d): d is string => !!d && isEmployerHost(d)).map(siteDomain))];
}

/** An apply address at a personal mail provider: only that exact sender is the employer. */
const exactSender = (c: Candidate) => (c.applyEmail && FREE_MAIL.test(emailDomain(c.applyEmail) ?? '') ? c.applyEmail.trim().toLowerCase() : null);

/** The company's name as people write it ("Acme Payments Pvt Ltd" → also "Acme Payments"). */
const companyNames = (company: string) => [...new Set([company, company.replace(/[,.]?\s+(?:inc|llc|ltd|limited|gmbh|pvt|private|plc|corp|corporation|co)\b\.?.*$/i, '')].map((s) => s.trim()).filter((s) => s.length >= 3))];
const companyKey = (c: Candidate) => companyNames(c.company).at(-1)!.toLowerCase();

/** The employer itself sent it: its domain, or its exact personal-mail apply address. */
function fromEmployer(sender: string, c: Candidate): boolean {
  const exact = exactSender(c);
  if (exact) return sender === exact;
  const domain = emailDomain(sender);
  return !!domain && isEmployerHost(domain) && companyDomains(c).includes(siteDomain(domain));
}

export function matchMessage(msg: IncomingMessage, candidates: Candidate[]): MatchResult | null {
  const thread = new Set([msg.inReplyTo, ...msg.references].filter((x): x is string => !!x).map(norm));
  const byThread = candidates.filter((c) => c.sentMessageIds.some((id) => thread.has(norm(id))));
  if (byThread.length === 1) return { applicationId: byThread[0].id, matchedBy: 'thread', score: 1 };

  const sender = msg.from.trim().toLowerCase();
  const domain = emailDomain(sender);
  const text = `${msg.fromName}\n${msg.subject}\n${msg.text.slice(0, 4000)}`;
  const titled = (c: Candidate) => mentions(text, c.jobTitle);
  const named = (c: Candidate) => companyNames(c.company).some((n) => mentions(text, n));
  const recruiting = RECRUITING_CUE.test(`${msg.subject}\n${msg.text.slice(0, 2000)}`);

  const scored: Array<MatchResult & { c: Candidate }> = [];
  for (const c of candidates) {
    let best: (MatchResult & { c: Candidate }) | null = null;
    if (fromEmployer(sender, c) && (recruiting || titled(c))) best = { applicationId: c.id, matchedBy: 'domain', score: 0.8, c };
    else if (domain && PLATFORM.test(domain) && named(c)) best = { applicationId: c.id, matchedBy: 'ats+company', score: 0.7, c };
    else if (named(c) && titled(c)) best = { applicationId: c.id, matchedBy: 'company+title', score: 0.6, c };
    if (best && titled(c)) best.score += 0.1;
    if (best) scored.push(best);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  // Within one company, the job title the mail names decides over how the mail was linked.
  const top = scored[0];
  const sameCompany = scored.filter((s) => companyKey(s.c) === companyKey(top.c) || companyDomains(s.c).some((d) => companyDomains(top.c).includes(d)));
  const titledHere = sameCompany.filter((s) => titled(s.c));
  if (titledHere.length === 1 && titledHere[0] !== top) return strip(titledHere[0]);
  // Two applications equally likely (e.g. the same company, no job title in the mail): don't guess.
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return strip(top);
}

const strip = (r: MatchResult & { c: Candidate }): MatchResult => ({ applicationId: r.applicationId, matchedBy: r.matchedBy, score: r.score });

/**
 * Cheap check on the envelope alone (no message text read): could this email be about one of the applications?
 * Only those are opened; everything else in the inbox is never read.
 */
export function couldBelong(env: { from: string; fromName?: string; subject: string; inReplyTo: string | null; references: string[] }, candidates: Candidate[]): boolean {
  const thread = new Set([env.inReplyTo, ...env.references].filter((x): x is string => !!x).map(norm));
  if (candidates.some((c) => c.sentMessageIds.some((id) => thread.has(norm(id))))) return true;
  const sender = env.from.trim().toLowerCase();
  if (candidates.some((c) => fromEmployer(sender, c))) return true;
  // Everyone else (job boards, ATS mail, recruiters) must name the company in the subject or sender name.
  const visible = `${env.fromName ?? ''}\n${env.subject}`;
  return candidates.some((c) => companyNames(c.company).some((n) => mentions(visible, n)));
}
