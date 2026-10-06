'use client';

import { useState } from 'react';
import { btn, input } from '@/components/ui';
import { defaultModelFor } from '@/server/ai/provider-view';
import { AI_PROVIDERS, AI_TASKS, PROVIDER_LABELS, TASK_LABELS, type AiProvider, type AiSettings, type AiTask } from '@/server/ai/settings';

const OTHER = '__other';
type Row = { provider: AiProvider; model: string; other: boolean };

/**
 * One row per AI task: its provider and model, plus "apply to all". Renders fields named
 * `tasks.<id>.provider` / `tasks.<id>.model` for the surrounding <form>; it saves nothing itself.
 * `models` lists each provider's known models; any other model can be typed ("Other…").
 */
export function AiTaskTable({ tasks, models }: { tasks: AiSettings['tasks']; models: Record<AiProvider, string[]> }) {
  const listed = (p: AiProvider) => models[p] ?? [];
  const toRow = (provider: AiProvider, model: string | null): Row => ({ provider, model: model ?? '', other: provider !== 'none' && !!model && !listed(provider).includes(model) });
  const [rows, setRows] = useState<Record<AiTask, Row>>(() => Object.fromEntries(AI_TASKS.map((t) => [t, toRow(tasks[t]?.provider ?? 'none', tasks[t]?.model ?? null)])) as Record<AiTask, Row>);
  const [all, setAll] = useState<Row>({ provider: 'none', model: '', other: false });
  const patch = (t: AiTask, r: Row) => setRows((x) => ({ ...x, [t]: r }));
  const pickProvider = (p: AiProvider): Row => ({ provider: p, model: defaultModelFor(p, listed(p)), other: false });

  /** Provider + model controls shared by the rows and the apply-to-all chooser. */
  const pair = (row: Row, set: (r: Row) => void, label: string, name?: (f: 'provider' | 'model') => string) => (
    <>
      <select aria-label={`Provider for ${label}`} name={name?.('provider')} className={input} value={row.provider} onChange={(e) => set(pickProvider(e.target.value as AiProvider))}>
        {AI_PROVIDERS.map((p) => (
          <option key={p} value={p}>{p === 'none' ? 'None (offline)' : PROVIDER_LABELS[p]}</option>
        ))}
      </select>
      {row.provider === 'none' ? (
        name && <input type="hidden" name={name('model')} value="" />
      ) : (
        <span className="flex flex-col gap-1">
          {listed(row.provider).length > 0 && (
            <select aria-label={`Model for ${label}`} className={input} value={row.other ? OTHER : row.model} onChange={(e) => set(e.target.value === OTHER ? { ...row, other: true } : { ...row, model: e.target.value, other: false })}>
              {!row.other && !row.model && <option value="">Choose a model…</option>}
              {listed(row.provider).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
          )}
          {(row.other || listed(row.provider).length === 0) && (
            <input aria-label={`Model name for ${label}`} className={input} value={row.model} placeholder="model name" onChange={(e) => set({ ...row, model: e.target.value, other: true })} />
          )}
          {name && <input type="hidden" name={name('model')} value={row.model} />}
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-2 rounded border border-neutral-200 p-3 text-sm sm:grid-cols-[1fr_1fr_auto] dark:border-neutral-800" data-testid="apply-to-all">
        {pair(all, setAll, 'all tasks')}
        <button type="button" className={btn} onClick={() => setRows(Object.fromEntries(AI_TASKS.map((t) => [t, all])) as Record<AiTask, Row>)}>Apply to all tasks</button>
      </div>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {AI_TASKS.map((t) => (
          <li key={t} className="grid items-start gap-2 py-3 text-sm sm:grid-cols-[1.2fr_1fr_1fr]" data-testid={`task-${t}`}>
            <div>
              <b>{TASK_LABELS[t].title}</b>
              <p className="text-neutral-600 dark:text-neutral-400">{TASK_LABELS[t].hint}</p>
            </div>
            {pair(rows[t], (r) => patch(t, r), TASK_LABELS[t].title.toLowerCase(), (f) => `tasks.${t}.${f}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}
