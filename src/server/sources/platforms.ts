import { NEVER_FETCH } from '../jobs/links';
import { listAdapters, type AnyAdapter } from './registry';
import type { Capability, ConfigField } from './types';

export type PlatformCategory = 'company_board' | 'aggregator' | 'web' | 'portal';

/**
 * One place jobs can come from. `connectable` platforms have an adapter and can be added as a source;
 * `manual` platforms have no adapter at all, so no code path can ever scan them (PRD §27).
 */
export interface Platform {
  id: string;
  name: string;
  description: string;
  homepage: string;
  category: PlatformCategory;
  status: 'connectable' | 'manual';
  capabilities: Capability[];
  /** Set on connectable platforms only. */
  adapterId?: string;
  configFields?: ConfigField[];
  requiresEnv?: string[];
  terms?: string;
  /** Why a manual platform can't be scanned, in plain words. */
  reason?: string;
  /** Manual platforms only: the site the user would copy a job from. */
  host?: string;
}

export const CAPABILITY_LABELS: Record<Capability, string> = {
  automaticScan: 'Scanned automatically',
  detectsClosedJobs: 'Notices when a job closes',
  search: 'Searches your job titles',
  findsBoards: 'Adds company boards it finds',
  readsWebPages: 'Reads job pages in a browser',
  addByUrl: 'Add by link',
  pasteJob: 'Paste a job',
};

/** What an adapter can do: two capabilities follow from its contract, the rest it declares itself. */
export function capabilitiesOf(adapter: AnyAdapter): Capability[] {
  return ['automaticScan', ...(adapter.completeSnapshot ? (['detectsClosedJobs'] as const) : []), ...(adapter.capabilities ?? [])];
}

function categoryOf(adapter: AnyAdapter): PlatformCategory {
  if (adapter.capabilities?.includes('readsWebPages')) return 'web';
  return adapter.identityKey ? 'company_board' : 'aggregator';
}

const TERMS_FORBID = 'Their terms forbid automated reading, so Job Scraper never fetches this site. Open the job there, copy it and use “Paste a job”.';
const NO_API = 'There is no public job API. Job Scraper can read a single public job page if you add it by link; otherwise paste the job.';

/** Job platforms with no connector. Listed so the user knows the supported way in, not as scraping targets. */
export const MANUAL_PLATFORMS: Array<Omit<Platform, 'status' | 'category'> & { host: string }> = [
  ['linkedin', 'LinkedIn', 'linkedin.com'],
  ['indeed', 'Indeed', 'indeed.com'],
  ['glassdoor', 'Glassdoor', 'glassdoor.com'],
  ['naukri', 'Naukri', 'naukri.com'],
  ['monster', 'Monster', 'monster.com'],
  ['ziprecruiter', 'ZipRecruiter', 'ziprecruiter.com'],
  ['foundit', 'foundit (Monster India)', 'foundit.in'],
  ['shine', 'Shine', 'shine.com'],
  ['wellfound', 'Wellfound (AngelList Talent)', 'wellfound.com'],
  ['cutshort', 'Cutshort', 'cutshort.io'],
  ['internshala', 'Internshala', 'internshala.com'],
].map(([id, name, host]) => {
  const blocked = NEVER_FETCH.test(host);
  return {
    id,
    name,
    host,
    homepage: `https://${host}`,
    description: `Jobs on ${name} are added by hand.`,
    reason: blocked ? TERMS_FORBID : NO_API,
    capabilities: blocked ? (['pasteJob'] as Capability[]) : (['addByUrl', 'pasteJob'] as Capability[]),
  };
});

/** The whole catalog: every connectable adapter, then the platforms that need manual work. */
export function listPlatforms(): Platform[] {
  const connectable: Platform[] = listAdapters()
    .filter((a) => !a.hidden)
    .map((a) => ({
      id: a.id,
      adapterId: a.id,
      name: a.displayName,
      description: a.description,
      homepage: a.homepage,
      category: categoryOf(a),
      status: 'connectable',
      capabilities: capabilitiesOf(a),
      configFields: a.configFields,
      requiresEnv: a.requiresEnv ?? [],
      terms: a.terms,
    }));
  const manual: Platform[] = MANUAL_PLATFORMS.map((p) => ({ ...p, category: 'portal', status: 'manual' }));
  return [...connectable, ...manual];
}
