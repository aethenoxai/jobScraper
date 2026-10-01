import type { Metadata } from 'next';
import { IntervalForm } from '@/components/settings/interval-form';
import { formatWhen } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { describeInterval, INTERVAL_PRESETS } from '@/server/scheduler';
import { getSystemStatus } from '@/server/status';
import Link from 'next/link';
import { runDiscoveryNow, saveInterval, startDiscovery, stopDiscovery } from './actions';

export const metadata: Metadata = { title: 'Scheduling' };

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  queued: 'Scan queued. The worker will pick it up within a few seconds.',
  already: 'A scan is already queued or running.',
  'invalid-interval': 'Frequency must be a whole number of minutes between 5 and 1440.',
};

const button = 'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';

export default async function SchedulingPage({ searchParams }: PageProps<'/settings/scheduling'>) {
  const { msg } = (await searchParams) as { msg?: string };
  const ctx = getAppContext();
  const status = getSystemStatus(ctx);
  const sourceList = ctx.sources.list().filter((s) => s.enabled);
  const lastSuccess = status.recentScans.find((r) => r.status === 'success' || r.status === 'partial');
  const now = status.generatedAt;
  const { scheduler } = status;

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold">Job discovery</h1>

      {msg && MESSAGES[msg] && (
        <p role="status" className="rounded border border-neutral-300 px-3 py-2 text-sm">{MESSAGES[msg]}</p>
      )}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-neutral-500">Status</dt>
        <dd data-testid="scheduler-status">{scheduler.enabled ? 'Running' : 'Paused'}</dd>
        <dt className="text-neutral-500">Frequency</dt>
        <dd data-testid="scheduler-interval">{describeInterval(scheduler.intervalMinutes)}</dd>
        <dt className="text-neutral-500">Last scan</dt>
        <dd>{status.lastScan ? `${formatWhen(status.lastScan.finishedAt ?? status.lastScan.startedAt, now)} (${status.lastScan.status})` : 'never'}</dd>
        <dt className="text-neutral-500">Last successful scan</dt>
        <dd>{lastSuccess ? formatWhen(lastSuccess.finishedAt ?? lastSuccess.startedAt, now) : 'never'}</dd>
        <dt className="text-neutral-500">Next scan</dt>
        <dd>{scheduler.enabled ? formatWhen(scheduler.nextRunAt, now) : '—'}</dd>
        <dt className="text-neutral-500">Worker</dt>
        <dd data-testid="worker-status">{status.worker.online ? 'Online' : 'Offline (run pnpm dev or pnpm start)'}</dd>
      </dl>

      <IntervalForm action={saveInterval} presets={INTERVAL_PRESETS.map((m) => ({ minutes: m, label: describeInterval(m) }))} value={scheduler.intervalMinutes} buttonClass={button} />

      <div className="flex gap-3">
        {scheduler.enabled ? (
          <form action={stopDiscovery}><button type="submit" className={button}>Stop</button></form>
        ) : (
          <form action={startDiscovery}><button type="submit" className={button}>Start</button></form>
        )}
        <form action={runDiscoveryNow}><button type="submit" className={button}>Run now</button></form>
      </div>

      <section>
        <h2 className="mb-2 font-medium">Sources</h2>
        {sourceList.length === 0 ? (
          <p className="text-sm text-neutral-500">No enabled sources. <Link href="/sources" className="underline">Add sources</Link>.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="source-status">
            {sourceList.map((s) => (
              <li key={s.id}>
                {s.lastStatus === 'failed' ? '⚠' : s.lastStatus === 'success' ? '✓' : '•'} {s.name}
                <span className="text-neutral-500"> · {s.lastStatus === 'failed' ? `unavailable: ${s.lastError}` : s.lastSuccessAt ? `last fetched ${formatWhen(s.lastSuccessAt, now)}` : s.lastError ?? 'not fetched yet'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">Recent scans</h2>
        {status.recentScans.length === 0 ? (
          <p className="text-sm text-neutral-500">No scans yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Found</th><th>New jobs</th><th>Updated</th></tr></thead>
            <tbody>
              {status.recentScans.map((r) => (
                <tr key={r.id}>
                  <td>{formatWhen(r.startedAt, now)}</td>
                  <td>{r.trigger}</td>
                  <td>{r.status}{r.error && <div className="text-xs text-neutral-500">{r.error}</div>}</td>
                  <td>{r.stats?.found ?? '—'}</td>
                  <td>{r.stats?.new ?? '—'}</td>
                  <td>{r.stats?.updated ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
