import type { Metadata } from 'next';
import Link from 'next/link';
import { AddJobForms } from '@/components/jobs/add-job-section';
import { Badge, btn, Card, input, PageHeader } from '@/components/ui';
import { formatWhen, requestTime, saysWorkMode } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { ADD_URL_TASK, addUrlNotes } from '@/server/discovery/add-url';
import { formatSalary, jobCounts, listJobs } from '@/server/jobs/queries';

export const metadata: Metadata = { title: 'All jobs' };

export const dynamic = 'force-dynamic';

export default async function JobsPage({ searchParams }: PageProps<'/jobs'>) {
  const sp = (await searchParams) as { q?: string; page?: string };
  const { db, queue, settings } = getAppContext();
  const now = requestTime();
  const page = Math.max(1, Number(sp.page) || 1);
  const result = listJobs(db, { q: sp.q, page, pageSize: 50, now: new Date(now) });
  const imports = queue.recent(ADD_URL_TASK, 5);
  const notes = addUrlNotes(settings);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const { active } = jobCounts(db, new Date(now));
  const q = sp.q?.trim();
  const link = (p: number) => `/jobs?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title="Discovered jobs"
        subtitle={
          <span>
            {active} active jobs from all sources{q ? `, ${result.total} found for “${q}”` : ''}. The ones that fit your profile are in the <Link href="/feed" className="underline">Job feed</Link>.
          </span>
        }
      />
      <Card title="Add a job yourself">
        <AddJobForms />
        {imports.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {imports.map((t) => (
              <li key={t.id} className="flex flex-wrap gap-2">
                <Badge tone={t.status === 'done' ? (notes.has(t.id) ? 'amber' : 'green') : t.status === 'failed' ? 'red' : 'blue'}>{t.status === 'done' ? (notes.has(t.id) ? 'Board added' : 'Added') : t.status === 'failed' ? 'Failed' : 'Working…'}</Badge>
                <span className="break-all">{(t.payload as { url?: string }).url}</span>
                {t.status === 'failed' && <span className="text-red-600">{t.lastError}</span>}
                {t.status === 'done' && notes.has(t.id) && <span className="text-amber-700 dark:text-amber-400">{notes.get(t.id)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <form className="flex gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search jobs</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Search title, company or location" className={`${input} max-w-md`} />
        <button className={btn}>Search</button>
      </form>

      {result.items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {active === 0 ? (
            <>No jobs yet. Start job discovery on the <Link href="/settings/scheduling" className="underline">Scheduling</Link> page, or add a job above.</>
          ) : q && result.total === 0 ? (
            <>No jobs found for “{q}”. <Link href="/jobs" className="underline">Show all jobs</Link></>
          ) : (
            <>There are no jobs on this page. <Link href={link(1)} className="underline">Go to the first page</Link></>
          )}
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-neutral-500">
            <tr><th className="py-2 pr-3">Job</th><th className="pr-3">Location</th><th className="hidden pr-3 md:table-cell">Salary</th><th className="hidden pr-3 md:table-cell">Source</th><th>Found</th></tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {result.items.map((j) => (
              <tr key={j.id} className="align-top">
                <td className="py-2 pr-3">
                  <Link href={`/jobs/${j.id}`} className="font-medium hover:underline">{j.title}</Link>{' '}
                  {j.state === 'new' && <Badge tone="green">New</Badge>}
                  {j.state === 'updated' && <Badge tone="blue">Updated</Badge>}
                  <div className="text-neutral-500">{j.company}</div>
                </td>
                <td className="pr-3">{j.location ?? '—'}{j.workMode && !saysWorkMode(j.location, j.workMode) && <div className="text-neutral-500">{j.workMode}</div>}</td>
                <td className="hidden pr-3 md:table-cell">{formatSalary(j) ?? '—'}</td>
                <td className="hidden pr-3 md:table-cell">{j.sources.join(', ')}</td>
                <td>{formatWhen(j.firstSeenAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {page > 1 && <Link href={link(page - 1)} className="underline">← Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link href={link(page + 1)} className="underline">Next →</Link>}
        </nav>
      )}
    </div>
  );
}
