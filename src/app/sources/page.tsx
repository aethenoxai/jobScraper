import type { Metadata } from 'next';
import { ConfirmButton } from '@/components/confirm-button';
import { AddSourceForm, EditSourceForm, type AdapterInfo } from '@/components/sources/source-config-form';
import { Badge, btn, btnDanger, Card, PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { getAdapter, listAdapters } from '@/server/sources/registry';
import { deleteSource, setSourceEnabled } from './actions';

export const metadata: Metadata = { title: 'Job sources' };

export const dynamic = 'force-dynamic';

const info = (a: NonNullable<ReturnType<typeof getAdapter>>): AdapterInfo => ({
  id: a.id,
  displayName: a.displayName,
  description: a.description,
  terms: a.terms,
  requiresEnv: a.requiresEnv ?? [],
  configFields: a.configFields,
});

const STATUS = { success: ['green', 'OK'], failed: ['red', 'Failing'], skipped: ['amber', 'Skipped'] } as const;

export default function SourcesPage() {
  const { sources } = getAppContext();
  const now = requestTime();
  const list = sources.list().filter((s) => s.adapterId !== 'manual');
  const counts = sources.listingCounts();
  const adapters = listAdapters().filter((a) => !a.hidden).map(info);
  const env = process.env;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Job sources" subtitle="Where Job Scraper looks for jobs. Company boards found by web discovery are added here automatically." />
      <Card title="Add a source">
        <AddSourceForm adapters={adapters} />
      </Card>
      {list.length === 0 && <p className="text-sm text-neutral-500">No sources yet. Default sources are added when the worker first starts.</p>}
      <ul className="space-y-3">
        {list.map((s) => {
          const adapter = getAdapter(s.adapterId);
          const missing = (adapter?.requiresEnv ?? []).filter((k) => !env[k]);
          const [tone, label] = s.lastStatus ? STATUS[s.lastStatus] : (['neutral', 'Not run yet'] as const);
          return (
            <li key={s.id} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid={`source-${s.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-x-2">
                  <span className="font-medium">{s.name}</span>
                  {s.name !== (adapter?.displayName ?? s.adapterId) && <Badge>{adapter?.displayName ?? s.adapterId}</Badge>}
                  {s.enabled ? <Badge tone={tone}>{label}</Badge> : <Badge>Disabled</Badge>}
                  {s.origin === 'discovered' && <Badge tone="blue">Found on the web</Badge>}
                  {missing.length > 0 && <Badge tone="amber">Needs {missing.join(', ')}</Badge>}
                </div>
                <div className="flex gap-2">
                  <form action={setSourceEnabled.bind(null, s.id, !s.enabled)}>
                    <button className={btn}>{s.enabled ? 'Disable' : 'Enable'}</button>
                  </form>
                  <form action={deleteSource.bind(null, s.id)}>
                    <ConfirmButton className={btnDanger} label={`Delete ${s.name}`} message={`Delete "${s.name}" and the jobs found only there?`}>Delete</ConfirmButton>
                  </form>
                </div>
              </div>
              <p className="mt-1 text-sm text-neutral-500">
                {counts.get(s.id) ?? 0} active jobs · last run {formatWhen(s.lastRunAt, now)} · last success {formatWhen(s.lastSuccessAt, now)}
              </p>
              {s.lastError && <p className="mt-1 text-sm text-red-600">{s.lastError}</p>}
              {adapter && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Settings and recent runs</summary>
                  <div className="mt-3 space-y-4">
                    <EditSourceForm sourceId={s.id} name={s.name} adapter={info(adapter)} values={(s.config ?? {}) as Record<string, unknown>} />
                    <table className="w-full text-left text-xs">
                      <thead><tr><th>Started</th><th>Status</th><th>Found</th><th>New jobs</th><th>Updated</th><th>Expired</th><th>Error</th></tr></thead>
                      <tbody>
                        {sources.recentRuns(s.id, 8).map((r) => (
                          <tr key={r.id}>
                            <td>{formatWhen(r.startedAt, now)}</td>
                            <td>{r.status}</td>
                            <td>{r.found}</td>
                            <td>{r.newJobs}</td>
                            <td>{r.updated}</td>
                            <td>{r.expired}</td>
                            <td className="text-red-600">{r.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
