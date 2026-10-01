import type { Metadata } from 'next';
import Link from 'next/link';
import { formatWhen } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { describeFailure } from '@/server/failures';
import { describeInterval } from '@/server/scheduler';
import { getSystemStatus } from '@/server/status';
import { jobCounts } from '@/server/jobs/queries';

export const metadata: Metadata = { title: { absolute: 'Dashboard · Job Scraper' } };

export const dynamic = 'force-dynamic';

const INTERVIEW_KINDS: Record<string, string> = { phone: 'Phone', video: 'Video', onsite: 'On-site', other: 'Interview' };

export default function Dashboard() {
  const ctx = getAppContext();
  const s = getSystemStatus(ctx);
  const jc = jobCounts(ctx.db, new Date(s.generatedAt));
  const failing = ctx.sources.list().filter((x) => x.enabled && x.lastStatus === 'failed');
  // Match numbers are for the default profile, so each card opens exactly the jobs it counts.
  const allProfiles = ctx.profiles.list();
  const profile = allProfiles.find((p) => p.isDefault) ?? allProfiles[0];
  const mc = ctx.matching.counts(profile?.id ?? -1, new Date(s.generatedAt));
  const apps = ctx.matching.counts(undefined, new Date(s.generatedAt));
  const now = s.generatedAt;
  const forProfile = allProfiles.length > 1 && profile ? ` · ${profile.name}` : '';
  const feed = (q: string) => `/feed?profile=${profile?.id ?? ''}${q}`;
  const cards = [
    { label: `New matches (24 h)${forProfile}`, value: String(mc.newMatches), href: feed('&fresh=new') },
    { label: `Matching jobs${forProfile}`, value: String(mc.matching), href: feed('') },
    { label: `Awaiting your approval${forProfile}`, value: String(mc.awaitingApproval), href: feed('&state=pending') },
    { label: 'Preparing', value: String(apps.preparing), href: '/applications?tab=preparing' },
    { label: 'Ready to apply', value: String(apps.ready), href: '/applications?tab=ready' },
    { label: 'Submitted', value: String(apps.submitted) },
    { label: 'Interviews', value: String(apps.interviews), href: '/applications?tab=interview' },
    { label: 'Offers', value: String(apps.offers), href: '/applications?tab=offer' },
    { label: 'Rejected', value: String(apps.rejected), href: '/applications?tab=rejected' },
    { label: 'Failed', value: String(apps.failed), href: '/applications?tab=failed' },
  ];
  const interviews = ctx.apps.upcomingInterviews(5);
  const system = [
    { label: 'Worker', value: s.worker.online ? 'Online' : 'Offline' },
    { label: 'Job discovery', value: s.scheduler.enabled ? describeInterval(s.scheduler.intervalMinutes) : 'Paused' },
    { label: 'Last scan', value: s.lastScan ? formatWhen(s.lastScan.finishedAt ?? s.lastScan.startedAt, now) : 'never' },
    { label: 'New jobs found (24 h)', value: String(jc.newToday) },
    { label: 'Active jobs', value: String(jc.active) },
    { label: 'Queued tasks', value: String(s.queue.pending + s.queue.running) },
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      {!s.worker.online && (
        <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-sm">
          The background worker is not running. Start Job Scraper with <code>pnpm dev</code> or <code>pnpm start</code>.
        </p>
      )}
      {s.lastScan?.status === 'failed' && (
        <p role="alert" className="rounded border border-red-400 px-3 py-2 text-sm" data-testid="discovery-failed">
          {describeFailure('JOB_DISCOVERY_FAILED').title} in the last scan. {describeFailure('JOB_DISCOVERY_FAILED').help} <Link href="/system" className="underline">Details</Link>
        </p>
      )}
      {failing.length > 0 && (
        <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-sm">
          {failing.length} job source{failing.length > 1 ? 's are' : ' is'} failing: {failing.map((f) => f.name).join(', ')}. <Link href="/sources" className="underline">Check sources</Link>
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {cards.map((c) => {
          const body = (
            <>
              <div className="text-xs uppercase text-neutral-500">{c.label}</div>
              <div className="mt-1 text-2xl font-semibold">{c.value}</div>
            </>
          );
          return c.href ? (
            <Link key={c.label} href={c.href} className="rounded border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800" data-testid={`metric-${c.label}`}>{body}</Link>
          ) : (
            <div key={c.label} className="rounded border border-neutral-200 p-4 dark:border-neutral-800" data-testid={`metric-${c.label}`}>{body}</div>
          );
        })}
      </div>
      {interviews.length > 0 && (
        <section data-testid="upcoming-interviews">
          <h2 className="pt-2 text-sm font-semibold uppercase text-neutral-500">Upcoming interviews</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {interviews.map((i) => (
              <li key={`${i.applicationId}-${i.at.getTime()}`}>
                <Link href={`/applications/${i.applicationId}`} className="underline">{i.jobTitle} at {i.company}</Link> · {i.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {INTERVIEW_KINDS[i.kind] ?? 'Interview'}{i.details ? ` · ${i.details}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      <h2 className="pt-2 text-sm font-semibold uppercase text-neutral-500">System</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {system.map((c) => (
          <div key={c.label} className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="text-xs uppercase text-neutral-500">{c.label}</div>
            <div className="mt-1 font-medium">{c.value}</div>
          </div>
        ))}
      </div>
      <Link href="/settings/scheduling" className="text-sm underline">Configure job discovery →</Link>
    </div>
  );
}
