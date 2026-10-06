import type { Metadata } from 'next';
import type { AdapterInfo } from '@/components/sources/source-config-form';
import { SourcesView, type ConnectedView, type PlatformView } from '@/components/sources/sources-view';
import { PageHeader } from '@/components/ui';
import { formatWhen, requestTime } from '@/lib/format';
import { getAppContext } from '@/server/context';
import { CAPABILITY_LABELS, listPlatforms } from '@/server/sources/platforms';
import { getAdapter } from '@/server/sources/registry';

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
  const counts = sources.listingCounts();
  const env = process.env;

  const connected: ConnectedView[] = sources
    .list()
    .filter((s) => s.adapterId !== 'manual')
    .map((s) => {
      const adapter = getAdapter(s.adapterId);
      const [statusTone, statusLabel] = s.lastStatus ? STATUS[s.lastStatus] : (['neutral', 'Not run yet'] as const);
      return {
        id: s.id,
        name: s.name,
        platformName: adapter?.displayName ?? s.adapterId,
        adapter: adapter ? info(adapter) : null,
        config: (s.config ?? {}) as Record<string, unknown>,
        enabled: s.enabled,
        discovered: s.origin === 'discovered',
        statusTone,
        statusLabel,
        activeJobs: counts.get(s.id) ?? 0,
        lastRun: formatWhen(s.lastRunAt, now),
        lastSuccess: formatWhen(s.lastSuccessAt, now),
        lastError: s.lastError,
        missingEnv: (adapter?.requiresEnv ?? []).filter((k) => !env[k]),
        runs: sources.recentRuns(s.id, 8).map((r) => ({ id: r.id, started: formatWhen(r.startedAt, now), status: r.status, found: r.found, newJobs: r.newJobs, updated: r.updated, expired: r.expired, error: r.error })),
      };
    });

  const connectedByAdapter = new Map<string, number>();
  for (const s of connected) connectedByAdapter.set(s.platformName, 0);
  const platforms: PlatformView[] = listPlatforms().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    homepage: p.homepage,
    category: p.category,
    status: p.status,
    capabilities: p.capabilities,
    capabilityLabels: p.capabilities.map((c) => CAPABILITY_LABELS[c]),
    reason: p.reason,
    requiresEnv: (p.requiresEnv ?? []).filter((k) => !env[k]),
    adapter: p.adapterId ? info(getAdapter(p.adapterId)!) : null,
    connectedCount: connected.filter((s) => s.adapter?.id === p.adapterId).length,
  }));

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Job sources" subtitle="Connect the places you want Job Scraper to find jobs in. Everything it finds is matched against your profile the same way, wherever it came from." />
      <SourcesView connected={connected} platforms={platforms} />
    </div>
  );
}
