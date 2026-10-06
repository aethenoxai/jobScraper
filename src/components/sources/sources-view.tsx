'use client';

import { useState } from 'react';
import { deleteSource, setSourceEnabled } from '@/app/(app)/sources/actions';
import { ConfirmButton } from '@/components/confirm-button';
import { AddJobForms } from '@/components/jobs/add-job-section';
import { AddSourceForm, EditSourceForm, type AdapterInfo } from '@/components/sources/source-config-form';
import { Badge, btn, btnDanger, btnPrimary, Card, input } from '@/components/ui';
import type { Capability } from '@/server/sources/types';

/** A configured source, pre-formatted on the server (this component holds no clock). */
export interface ConnectedView {
  id: number;
  name: string;
  platformName: string;
  adapter: AdapterInfo | null;
  config: Record<string, unknown>;
  enabled: boolean;
  discovered: boolean;
  statusTone: 'green' | 'red' | 'amber' | 'neutral';
  statusLabel: string;
  activeJobs: number;
  lastRun: string;
  lastSuccess: string;
  lastError: string | null;
  missingEnv: string[];
  runs: Array<{ id: number; started: string; status: string; found: number; newJobs: number; updated: number; expired: number; error: string | null }>;
}

export interface PlatformView {
  id: string;
  name: string;
  description: string;
  homepage: string;
  category: string;
  status: 'connectable' | 'manual';
  capabilities: Capability[];
  capabilityLabels: string[];
  reason?: string;
  requiresEnv: string[];
  adapter: AdapterInfo | null;
  connectedCount: number;
}

const Caps = ({ labels }: { labels: string[] }) => (
  <ul className="mt-2 flex flex-wrap gap-1">
    {labels.map((l) => (
      <li key={l}><Badge>{l}</Badge></li>
    ))}
  </ul>
);

function Section({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-medium">{title} <span className="text-neutral-500">({count})</span></h2>
        <p className="text-sm text-neutral-500">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function ConnectedCard({ s }: { s: ConnectedView }) {
  return (
    <li className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid={`source-${s.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-x-2">
          <span className="font-medium">{s.name}</span>
          {s.name !== s.platformName && <Badge>{s.platformName}</Badge>}
          {s.enabled ? <Badge tone={s.statusTone}>{s.statusLabel}</Badge> : <Badge>Disabled</Badge>}
          {s.discovered && <Badge tone="blue">Found on the web</Badge>}
          {s.missingEnv.length > 0 && <Badge tone="amber">Needs {s.missingEnv.join(', ')}</Badge>}
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
        {s.activeJobs} active jobs · last run {s.lastRun} · last success {s.lastSuccess}
      </p>
      {s.lastError && <p className="mt-1 text-sm text-red-600">{s.lastError}</p>}
      {s.adapter && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Settings and recent runs</summary>
          <div className="mt-3 space-y-4">
            <EditSourceForm sourceId={s.id} name={s.name} adapter={s.adapter} values={s.config} />
            <table className="w-full text-left text-xs">
              <thead><tr><th>Started</th><th>Status</th><th>Found</th><th>New jobs</th><th>Updated</th><th>Expired</th><th>Error</th></tr></thead>
              <tbody>
                {s.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.started}</td>
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
}

function PlatformCard({ p }: { p: PlatformView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid={`platform-${p.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="font-medium">{p.name}</span>
          {p.connectedCount > 0 && <span className="ml-2"><Badge tone="green">{p.connectedCount} connected</Badge></span>}
          {p.status === 'manual' && <span className="ml-2"><Badge tone="amber">Manual only</Badge></span>}
          <p className="mt-1 max-w-prose text-sm text-neutral-500">{p.status === 'manual' ? p.reason : p.description}</p>
        </div>
        {p.adapter && (
          <button type="button" className={open ? btn : btnPrimary} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Cancel' : 'Add'}
          </button>
        )}
      </div>
      <Caps labels={p.capabilityLabels} />
      {p.requiresEnv.length > 0 && <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">Needs {p.requiresEnv.join(' and ')} in your .env file.</p>}
      {open && p.adapter && (
        <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <AddSourceForm adapters={[p.adapter]} />
        </div>
      )}
    </li>
  );
}

const matches = (q: string, ...fields: Array<string | undefined>) => !q || fields.some((f) => f?.toLowerCase().includes(q));

export function SourcesView({ connected, platforms }: { connected: ConnectedView[]; platforms: PlatformView[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = connected.filter((s) => matches(q, s.name, s.platformName));
  const available = platforms.filter((p) => p.status === 'connectable' && matches(q, p.name, p.description, p.category));
  const manual = platforms.filter((p) => p.status === 'manual' && matches(q, p.name, p.reason));
  const nothing = shown.length + available.length + manual.length === 0;

  return (
    <div className="space-y-8">
      <label className="flex flex-col gap-1 text-sm">
        Search platforms
        <input className={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="greenhouse, remote, linkedin…" aria-label="Search platforms" />
      </label>

      {nothing && <p className="text-sm text-neutral-500">Nothing matches “{query}”. Any public job page can still be added with “Add by link” below.</p>}

      <Section title="Connected" hint="Searched on every scan. Company boards found by web discovery appear here automatically." count={shown.length}>
        <ul className="space-y-3">{shown.map((s) => <ConnectedCard key={s.id} s={s} />)}</ul>
      </Section>

      <Section title="Available platforms" hint="Add one to have Job Scraper search it for you." count={available.length}>
        <ul className="space-y-3">{available.map((p) => <PlatformCard key={p.id} p={p} />)}</ul>
      </Section>

      <Section title="Needs manual work" hint="Job Scraper does not scan these. Add their jobs one at a time below." count={manual.length}>
        <ul className="space-y-3">{manual.map((p) => <PlatformCard key={p.id} p={p} />)}</ul>
      </Section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Add a job yourself</h2>
          <p className="text-sm text-neutral-500">Works for any site, including the ones above. Jobs added here are matched like every other job.</p>
        </div>
        <Card title="Custom"><AddJobForms /></Card>
      </section>
    </div>
  );
}
