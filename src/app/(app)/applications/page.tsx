import type { Metadata } from 'next';
import Link from 'next/link';
import { sourceLabel } from '@/server/jobs/links';
import { AutoRefresh } from '@/components/auto-refresh';
import { Badge, Notice, PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { STATUS_LABELS, STATUS_TABS } from '@/server/applications/state';
import { getAppContext } from '@/server/context';

export const metadata: Metadata = { title: 'Applications' };

export const dynamic = 'force-dynamic';

type Search = { tab?: string; page?: string; msg?: string };

export default async function ApplicationsPage({ searchParams }: PageProps<'/applications'>) {
  const sp = (await searchParams) as Search;
  const { apps, profiles } = getAppContext();
  const tab = STATUS_TABS.find((t) => t.key === sp.tab) ?? STATUS_TABS[0];
  const page = Math.max(1, Number(sp.page) || 1);
  const list = apps.list({ status: tab.statuses ?? undefined, page, pageSize: 50 });
  const counts = apps.counts();
  const batch = apps.batchProgress();
  const profileNames = new Map(profiles.list().map((p) => [p.id, p.name]));
  const now = requestTime();
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const countOf = (statuses: typeof tab.statuses) => (statuses ? statuses.reduce((a, s) => a + counts[s], 0) : Object.values(counts).reduce((a, b) => a + b, 0));

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Applications" subtitle="Every job you approved, with its tailored CV, status and history." />
      {batch.preparing > 0 && <AutoRefresh everyMs={5000} />}
      {sp.msg === 'deleted' && <Notice tone="green">Application deleted with all its files. Your profile and master CV were not changed.</Notice>}
      {sp.msg === 'gone' && <Notice tone="amber">That application no longer exists (it was deleted).</Notice>}
      {batch.approved > 0 && (
        <p className="text-sm" data-testid="batch-progress">
          Approved in the last 24 hours: <b>{batch.approved}</b> · {batch.ready} ready · {batch.preparing} preparing{batch.failed ? ` · ${batch.failed} failed` : ''}
        </p>
      )}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Application status">
        {STATUS_TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'all' ? '/applications' : `/applications?tab=${t.key}`}
            aria-current={t.key === tab.key ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 ${t.key === tab.key ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900' : 'border-neutral-300 dark:border-neutral-700'}`}
          >
            {t.label} ({countOf(t.statuses)})
          </Link>
        ))}
      </nav>
      {list.items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {tab.key === 'all' ? <>No applications yet. Approve a job in your <Link href="/feed" className="underline">job feed</Link> and Job Scraper prepares a tailored CV for it.</> : 'Nothing here.'}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {list.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="application-row">
              <div className="min-w-0">
                <Link href={`/applications/${a.id}`} className="font-semibold hover:underline">{a.jobTitle}</Link>
                <div className="text-sm text-neutral-600 dark:text-neutral-400">
                  {a.company}{a.location ? ` · ${a.location}` : ''} · via {sourceLabel(a.sourceName, a.sourceUrl)}
                  {profileNames.size > 1 ? ` · ${profileNames.get(a.profileId) ?? 'deleted profile'}` : ''}
                </div>
                <div className="text-xs text-neutral-500">Approved {formatWhen(a.approvedAt, now)} · updated {formatWhen(a.updatedAt, now)}</div>
                {a.failureReason && <div className="text-xs text-red-600">{a.failureReason}</div>}
              </div>
              <Badge tone={a.status === 'READY' ? 'green' : a.status.includes('FAILED') ? 'red' : a.status === 'PREPARING' ? 'amber' : 'neutral'}>{STATUS_LABELS[a.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {page > 1 && <Link href={`/applications?tab=${tab.key}&page=${page - 1}`} className="underline">← Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link href={`/applications?tab=${tab.key}&page=${page + 1}`} className="underline">Next →</Link>}
        </nav>
      )}
    </div>
  );
}
