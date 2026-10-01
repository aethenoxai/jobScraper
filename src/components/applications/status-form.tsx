'use client';

import { btn, input } from '@/components/ui';

/** Statuses that close the application for good: changing to one asks first. */
const FINAL = new Set(['WITHDRAWN', 'REJECTED']);

/** "Update status" with no preselected choice, and a confirmation before a status that can't be undone. */
export function StatusForm({ action, options }: { action: (formData: FormData) => void | Promise<void>; options: Array<{ value: string; label: string }> }) {
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        const status = String(new FormData(e.currentTarget).get('status') ?? '');
        const label = options.find((o) => o.value === status)?.label.toLowerCase() ?? status;
        if (FINAL.has(status) && !window.confirm(`Mark this application as ${label}? This closes it and can't be undone.`)) e.preventDefault();
      }}
    >
      <label className="flex flex-col gap-1">New status
        <select name="status" className={input} defaultValue="" required>
          <option value="" disabled>Choose…</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Note (optional)<input name="note" className={input} placeholder="e.g. recruiter called" /></label>
      <button className={btn}>Update status</button>
    </form>
  );
}
