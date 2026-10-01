import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { MatchCard } from '@/components/feed/match-card';
import { btn, input, Notice, PageHeader } from '@/components/ui';
import { requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { describeSlider } from '@/server/matching/slider';
import { rescoreProfile, undoSkipMatch } from './actions';
import { LAST_SKIPPED_COOKIE } from './last-skipped';

export const metadata: Metadata = { title: 'Job feed' };

export const dynamic = 'force-dynamic';

type Search = { profile?: string; view?: string; state?: string; q?: string; sort?: string; page?: string; mode?: string; msg?: string; min?: string; source?: string; found?: string; fresh?: string };

export default async function FeedPage({ searchParams }: PageProps<'/feed'>) {
  const sp = (await searchParams) as Search;
  const { profiles, matching, sources } = getAppContext();
  const all = profiles.list();
  if (all.length === 0) {
    return (
      <div className="max-w-3xl space-y-4">
        <PageHeader title="Job feed" />
        <p className="text-sm">Create a profile and upload your CV first. <Link href="/profiles" className="underline">Go to profiles</Link></p>
      </div>
    );
  }
  const profile = all.find((p) => p.id === Number(sp.profile)) ?? all.find((p) => p.isDefault) ?? all[0];
  const view = sp.view === 'filtered' ? 'filtered' : 'surfaced';
  const state = (['NEW', 'VIEWED', 'APPROVED', 'SKIPPED', 'pending'] as const).find((s) => s === sp.state);
  const page = Math.max(1, Number(sp.page) || 1);
  const fresh: 'new' | 'updated' | undefined = sp.fresh === 'new' || sp.fresh === 'updated' ? sp.fresh : undefined;
  const filters = {
    state,
    q: sp.q,
    workMode: sp.mode || undefined,
    sourceId: Number(sp.source) || undefined,
    foundWithinDays: Number(sp.found) || undefined,
    fresh,
  };
  // The minimum-match filter is about matches: filtered-out jobs scored below the threshold anyway.
  const minScore = view === 'surfaced' ? Number(sp.min) || undefined : undefined;
  const feed = matching.feed(profile.id, { ...filters, view, minScore, sort: sp.sort === 'date' ? 'date' : 'score', page, pageSize: 30 });
  const otherTotal = matching.feed(profile.id, { ...filters, view: view === 'surfaced' ? 'filtered' : 'surfaced', minScore: view === 'surfaced' ? undefined : Number(sp.min) || undefined, pageSize: 1 }).total;
  const totals = view === 'surfaced' ? { surfaced: feed.total, filtered: otherTotal } : { surfaced: otherTotal, filtered: feed.total };
  const filtering = Object.values(filters).some(Boolean) || !!minScore;
  const sourceList = sources.list();
  const skippedId = Number((await cookies()).get(LAST_SKIPPED_COOKIE)?.value);
  const skipped = skippedId ? matching.get(skippedId) : null;
  const lastSkipped = skipped && skipped.reviewState === 'SKIPPED' && skipped.profileId === profile.id ? skipped : null;
  const now = requestTime();
  const pages = Math.max(1, Math.ceil(feed.total / feed.pageSize));
  const link = (over: Partial<Search>) => `/feed?${new URLSearchParams(Object.entries({ profile: String(profile.id), view, state, q: sp.q, sort: sp.sort, mode: sp.mode, min: sp.min, source: sp.source, found: sp.found, fresh, ...over }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Job feed"
        subtitle={describeSlider(profile.sliderValue)}
        actions={
          <form action={rescoreProfile.bind(null, profile.id)}>
            <button className={btn}>Re-check all jobs</button>
          </form>
        }
      />
      {sp.msg === 'rescoring' && <Notice>Re-checking every job against this profile in the background…</Notice>}
      {lastSkipped && (
        // Pinned to the bottom of the screen: the card that was skipped may be far down the list.
        <div className="fixed inset-x-4 bottom-4 z-40 rounded-md bg-white shadow-lg md:left-auto md:right-6 md:w-96 dark:bg-neutral-900">
          <Notice>
            <span className="flex flex-wrap items-center gap-3">
              Skipped “{lastSkipped.job.title}” at {lastSkipped.job.company}.
              <form action={undoSkipMatch.bind(null, lastSkipped.id)}><button className={btn}>Undo</button></form>
            </span>
          </Notice>
        </div>
      )}

      <form className="flex flex-wrap items-end gap-2 text-sm" role="search">
        {all.length > 1 && (
          <label className="flex flex-col gap-1">Profile
            <select name="profile" defaultValue={profile.id} className={input}>
              {all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <input type="hidden" name="view" value={view} />
        <label className="flex flex-col gap-1">Show
          <select name="state" defaultValue={state ?? ''} className={input}>
            <option value="">All</option>
            <option value="pending">Awaiting your decision</option>
            <option value="NEW">New</option>
            <option value="APPROVED">Approved</option>
            <option value="SKIPPED">Skipped</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Work mode
          <select name="mode" defaultValue={sp.mode ?? ''} className={input}>
            <option value="">Any</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </select>
        </label>
        {view === 'surfaced' ? (
          <label className="flex flex-col gap-1">Minimum match
            <select name="min" defaultValue={sp.min ?? ''} className={input}>
              <option value="">Any</option>
              {[60, 70, 80, 90].map((n) => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </label>
        ) : (
          // Filtered-out jobs scored below the threshold anyway; the setting is kept for the Matches tab.
          sp.min && <input type="hidden" name="min" value={sp.min} />
        )}
        <label className="flex flex-col gap-1">Found
          <select name="found" defaultValue={sp.found ?? ''} className={input}>
            <option value="">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">New or updated
          <select name="fresh" defaultValue={fresh ?? ''} className={input}>
            <option value="">All</option>
            <option value="new">New matches (24 h)</option>
            <option value="updated">Updated postings</option>
          </select>
        </label>
        {sourceList.length > 1 && (
          <label className="flex flex-col gap-1">Source
            <select name="source" defaultValue={sp.source ?? ''} className={input}>
              <option value="">Any</option>
              {sourceList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">Sort
          <select name="sort" defaultValue={sp.sort ?? 'score'} className={input}>
            <option value="score">Best match</option>
            <option value="date">Newest</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Search
          <input name="q" defaultValue={sp.q} placeholder="Title or company" className={input} />
        </label>
        <button className={btn}>Apply filters</button>
      </form>

      <nav className="flex gap-4 text-sm" aria-label="Views">
        <Link href={link({ view: 'surfaced', page: undefined })} aria-current={view === 'surfaced' ? 'page' : undefined} className={view === 'surfaced' ? 'font-semibold underline' : 'underline'}>Matches ({totals.surfaced})</Link>
        <Link href={link({ view: 'filtered', page: undefined })} aria-current={view === 'filtered' ? 'page' : undefined} className={view === 'filtered' ? 'font-semibold underline' : 'underline'}>Filtered out ({totals.filtered})</Link>
      </nav>

      {feed.items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {filtering ? (
            <>No jobs fit these filters. <Link href={`/feed?profile=${profile.id}&view=${view}`} className="underline">Clear the filters</Link></>
          ) : view === 'filtered' ? (
            'Nothing filtered out yet.'
          ) : (
            'No matching jobs yet. Job Scraper keeps searching; you can also lower the matching level in your profile preferences.'
          )}
        </p>
      ) : (
        <ul className="space-y-3">
          {feed.items.map((item) => <MatchCard key={item.matchId} item={item} now={now} />)}
        </ul>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {page > 1 && <Link href={link({ page: String(page - 1) })} className="underline">← Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link href={link({ page: String(page + 1) })} className="underline">Next →</Link>}
        </nav>
      )}
    </div>
  );
}
