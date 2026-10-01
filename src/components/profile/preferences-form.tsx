'use client';

import { useState, useTransition } from 'react';
import { savePreferences } from '@/app/(app)/profiles/actions';
import { btnPrimary, input } from '@/components/ui';
import { describeSlider, SLIDER_RANGE } from '@/server/matching/slider';
import { EMPLOYMENT_TYPES, WORK_MODES, type Preferences } from '@/server/profile/model';

import { joinPlaces, parseCsv as csv, parsePlaces } from '@/lib/lists';
import { unrecognisedPlaces } from '@/server/matching/geo';

export function PreferencesForm({ profileId, initial, initialSlider }: { profileId: number; initial: Preferences; initialSlider: number }) {
  const [prefs, setPrefs] = useState(initial);
  const [slider, setSlider] = useState(initialSlider);
  const [status, setStatus] = useState<{ ok: boolean; message?: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<Preferences>) => setPrefs((p) => ({ ...p, ...patch }));
  type ListKey = 'targetTitles' | 'locations' | 'includeKeywords' | 'excludeKeywords' | 'excludedCompanies';
  const [raw, setRaw] = useState<Record<ListKey, string>>(() => ({
    targetTitles: initial.targetTitles.join(', '),
    locations: joinPlaces(initial.locations),
    includeKeywords: initial.includeKeywords.join(', '),
    excludeKeywords: initial.excludeKeywords.join(', '),
    excludedCompanies: initial.excludedCompanies.join(', '),
  }));
  const unknownPlaces = unrecognisedPlaces(prefs.locations);
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const list = (label: string, key: ListKey, placeholder: string, hint?: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        className={input}
        value={raw[key]}
        placeholder={placeholder}
        onChange={(e) => {
          const value = e.target.value;
          setRaw((r) => ({ ...r, [key]: value }));
          set({ [key]: key === 'locations' ? parsePlaces(value) : csv(value) });
        }}
      />
      {hint}
    </label>
  );

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setStatus(await savePreferences(profileId, prefs, slider)));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {list('Job titles to look for', 'targetTitles', 'e.g. Full Stack Engineer, Backend Developer')}
        {list(
          'Where you want to work',
          'locations',
          'e.g. Bangalore, Delhi NCR, India, United Kingdom',
          <span className="text-xs text-zinc-500">
            Use semicolons to qualify a place (Cambridge, UK; Pune).
            {unknownPlaces.length > 0 && (
              <span className="block text-amber-700 dark:text-amber-400">
                Not recognised, so only jobs whose location names them will match: {unknownPlaces.join(', ')}. Listing nearby cities or the country widens the search.
              </span>
            )}
          </span>,
        )}
        <label className="flex flex-col gap-1 text-sm">
          Remote jobs
          <select className={input} value={prefs.remoteScope} onChange={(e) => set({ remoteScope: e.target.value as Preferences['remoteScope'] })}>
            <option value="none">Hide remote jobs</option>
            <option value="country">Remote jobs open to my locations</option>
            <option value="worldwide">Remote jobs from anywhere</option>
          </select>
        </label>
        <fieldset className="text-sm">
          <legend className="mb-1">Work modes</legend>
          <div className="flex gap-4">
            {WORK_MODES.map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input type="checkbox" checked={prefs.workModes.includes(m)} onChange={() => set({ workModes: toggle(prefs.workModes, m) })} /> {m}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="text-sm sm:col-span-2">
          <legend className="mb-1">Employment types</legend>
          <div className="flex flex-wrap gap-4">
            {EMPLOYMENT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="checkbox" checked={prefs.employmentTypes.includes(t)} onChange={() => set({ employmentTypes: toggle(prefs.employmentTypes, t) })} /> {t}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1 text-sm">
          <label className="flex flex-col gap-1">
            Expected salary / CTC (yearly, optional)
            <input className={input} type="number" min={0} step="any" value={prefs.salaryMin ?? ''} onChange={(e) => set({ salaryMin: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            <input type="checkbox" checked={!!prefs.salaryNegotiable} onChange={(e) => set({ salaryNegotiable: e.target.checked })} /> Negotiable: also show jobs that pay less (with a note)
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Currency (3 letters)
          <input className={input} maxLength={3} pattern="[A-Za-z]{3}" title="A 3-letter currency code such as EUR, USD or INR" value={prefs.salaryCurrency ?? ''} placeholder="INR" onChange={(e) => set({ salaryCurrency: e.target.value.trim() ? e.target.value.toUpperCase() : null })} />
        </label>
        {list('Must mention (optional keywords)', 'includeKeywords', 'e.g. React')}
        {list('Skip jobs mentioning', 'excludeKeywords', 'e.g. unpaid, commission only')}
        {list('Skip these companies', 'excludedCompanies', 'e.g. my current employer')}
      </div>

      <div className="space-y-1">
        <label htmlFor="slider" className="text-sm font-medium">Matching and tailoring level: {slider}%</label>
        <input id="slider" type="range" min={SLIDER_RANGE.min} max={SLIDER_RANGE.max} step={5} value={slider} onChange={(e) => setSlider(Number(e.target.value))} className="w-full" />
        <div className="flex justify-between text-xs text-neutral-500"><span>70% (more jobs)</span><span>200% (fewest, most tailored)</span></div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="slider-description">{describeSlider(slider)}</p>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Saving…' : 'Save preferences'}</button>
        {status && <span role="status" className={`text-sm ${status.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{status.message}</span>}
      </div>
    </form>
  );
}
