import type { Metadata } from 'next';
import Link from 'next/link';
import { hasRealLink, sourceLabel } from '@/server/jobs/links';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader } from '@/components/ui';
import { formatWhen, placeOf, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { formatSalary, getJob } from '@/server/jobs/queries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/jobs/[id]'>): Promise<Metadata> {
  const job = getJob(getAppContext().db, Number((await params).id));
  return { title: job ? `${job.title} at ${job.company}` : 'Job' };
}

export default async function JobPage({ params }: PageProps<'/jobs/[id]'>) {
  const { id } = (await params) as { id: string };
  const job = getJob(getAppContext().db, Number(id));
  if (!job) notFound();
  const now = requestTime();
  const salary = formatSalary(job);
  const main = job.listings.find((l) => l.description) ?? job.listings[0];

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={job.title}
        subtitle={
          <span>
            <Link href="/jobs" className="underline">← All jobs</Link> · {job.company} · {placeOf(job.location, job.workMode)}
            {salary ? ` · ${salary}` : ''} {job.status === 'expired' && <Badge tone="red">No longer listed</Badge>}
          </span>
        }
      />
      {job.matches.length > 0 && (
        <Card title="How it matches you">
          <ul className="space-y-1 text-sm">
            {job.matches.map((m) => (
              <li key={m.matchId}>
                <Link href={`/feed/${m.matchId}`} className="underline">{job.matches.length > 1 ? `${m.profileName}: ` : ''}{m.method === 'gate' ? 'not scored' : `${m.score}% match`}</Link>{' '}
                {m.method === 'gate' ? <span className="text-neutral-500">({m.filterReason})</span> : m.decision === 'filtered' && <Badge>Filtered out</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={`Where it is listed (${job.listings.length})`}>
        <ul className="space-y-2 text-sm">
          {job.listings.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <Badge>{l.sourceName}</Badge>
              {hasRealLink(l.sourceUrl) ? <a href={l.sourceUrl} target="_blank" rel="noreferrer" className="underline">View on {sourceLabel(l.sourceName, l.sourceUrl)}</a> : <span className="text-neutral-500">Pasted by you (no link)</span>}
              {l.applicationUrl && l.applicationUrl !== l.sourceUrl && (
                <a href={l.applicationUrl} target="_blank" rel="noreferrer" className="underline">Application page</a>
              )}
              {l.applyEmail && <span>Apply by email: {l.applyEmail}</span>}
              <span className="text-neutral-500">first seen {formatWhen(l.firstSeenAt, now)}</span>
              {l.status === 'expired' && <Badge tone="red">Removed</Badge>}
            </li>
          ))}
        </ul>
      </Card>
      {main && (
        <Card title="Job description">
          <div className="whitespace-pre-line text-sm leading-6 [overflow-wrap:anywhere]">{main.description || 'The source did not include a description.'}</div>
        </Card>
      )}
    </div>
  );
}
