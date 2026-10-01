'use client';

import { useActionState, useState } from 'react';
import { createSource, updateSourceConfig, type SourceActionResult } from '@/app/sources/actions';
import { btnPrimary, input } from '@/components/ui';

export interface AdapterInfo {
  id: string;
  displayName: string;
  description: string;
  terms?: string;
  requiresEnv: string[];
  configFields: Array<{ key: string; label: string; placeholder?: string; help?: string; optional?: boolean }>;
}

function Fields({ adapter, values }: { adapter: AdapterInfo; values?: Record<string, unknown> }) {
  return (
    <>
      {adapter.configFields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-sm">
          {f.label}
          {f.optional ? ' (optional)' : ''}
          <input name={`config.${f.key}`} className={input} placeholder={f.placeholder} defaultValue={values?.[f.key] == null ? '' : String(values[f.key])} required={!f.optional} />
          {f.help && <span className="text-xs text-neutral-500">{f.help}</span>}
        </label>
      ))}
    </>
  );
}

function Result({ state }: { state: SourceActionResult | null }) {
  if (!state) return null;
  return <span role="status" className={`text-sm ${state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{state.message}</span>;
}

export function AddSourceForm({ adapters }: { adapters: AdapterInfo[] }) {
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? '');
  const [state, action, pending] = useActionState(createSource, null);
  const adapter = adapters.find((a) => a.id === adapterId);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Source type
        <select name="adapterId" className={input} value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>{a.displayName}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" className={input} placeholder={adapter?.displayName} />
      </label>
      {adapter && (
        <>
          <p className="text-sm text-neutral-500 sm:col-span-2">
            {adapter.description} {adapter.terms} {adapter.requiresEnv.length > 0 && `Needs ${adapter.requiresEnv.join(' and ')} in your .env file.`}
          </p>
          <Fields key={adapter.id} adapter={adapter} />
        </>
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={btnPrimary} disabled={pending}>Add source</button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function EditSourceForm({ sourceId, name, adapter, values }: { sourceId: number; name: string; adapter: AdapterInfo; values: Record<string, unknown> }) {
  const [state, action, pending] = useActionState(updateSourceConfig.bind(null, sourceId, adapter.id), null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" className={input} defaultValue={name} />
      </label>
      <Fields adapter={adapter} values={values} />
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={btnPrimary} disabled={pending}>Save</button>
        <Result state={state} />
      </div>
    </form>
  );
}
