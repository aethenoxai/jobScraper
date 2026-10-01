'use client';

import { useRef } from 'react';

/** Frequency picker: typing a number of minutes selects "Custom…", so what was typed is what gets saved. */
export function IntervalForm({ action, presets, value, buttonClass }: { action: (formData: FormData) => void | Promise<void>; presets: Array<{ minutes: number; label: string }>; value: number; buttonClass: string }) {
  const select = useRef<HTMLSelectElement>(null);
  const isPreset = presets.some((p) => p.minutes === value);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col text-sm">
        <label htmlFor="preset">Frequency</label>
        <select ref={select} id="preset" name="preset" defaultValue={isPreset ? String(value) : 'custom'} className="rounded border px-2 py-1">
          {presets.map((p) => (
            <option key={p.minutes} value={p.minutes}>{p.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>
      <div className="flex flex-col text-sm">
        <label htmlFor="customMinutes">Custom (minutes)</label>
        <input
          id="customMinutes"
          name="customMinutes"
          type="number"
          min={5}
          max={1440}
          defaultValue={isPreset ? undefined : value}
          onInput={() => {
            if (select.current) select.current.value = 'custom';
          }}
          className="w-28 rounded border px-2 py-1"
        />
      </div>
      <button type="submit" className={buttonClass}>Save frequency</button>
    </form>
  );
}
