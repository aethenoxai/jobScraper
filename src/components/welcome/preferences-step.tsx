'use client';

import Link from 'next/link';
import { useState, useTransition, type ReactNode } from 'react';
import { saveJobPreferencesStep } from '@/app/welcome/actions';
import { btn, btnPrimary, Card, input } from '@/components/ui';
import { countryChoices, currencyOf, placeChoices } from '@/server/matching/geo';
import { describeSlider, SLIDER_RANGE } from '@/server/matching/slider';
import type { JobPreferencesInput, SavePreferencesResult } from '@/server/onboarding-steps';
import { EMPLOYMENT_TYPES, WORK_MODES } from '@/server/profile/model';

const COUNTRIES = countryChoices();
const MODE_LABELS: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };
const TYPE_LABELS: Record<string, string> = { 'full-time': 'Full-time', 'part-time': 'Part-time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary' };
type Errors = Extract<SavePreferencesResult, { ok: false }>['errors'];

function Problem({ text }: { text?: string }) {
  return text ? <span role="alert" className="text-xs text-red-600">{text}</span> : null;
}

/** A list of values shown as removable chips, with an input (and suggestions) to add more. */
function Chips({ label, values, onChange, options, placeholder, hint, error, testId }: { label: ReactNode; values: string[]; onChange: (v: string[]) => void; options?: string[]; placeholder: string; hint?: string; error?: string; testId: string }) {
  const [draft, setDraft] = useState('');
  const listId = `${testId}-options`;
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={testId}>{label}</label>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid={`${testId}-chips`}>
          {values.map((v) => (
            <li key={v} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
              {v}
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={testId}
          className={input}
          list={options ? listId : undefined}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <button type="button" className={btn} onClick={add}>Add</button>
      </div>
      {options && <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
      {hint && <span className="text-xs text-neutral-500">{hint}</span>}
      <Problem text={error} />
    </div>
  );
}

/** Step 4: which jobs, where, and for what pay. Nothing is searched without these answers. */
export function PreferencesStep({ initial }: { initial: JobPreferencesInput }) {
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, start] = useTransition();
  const set = (patch: Partial<JobPreferencesInput>) => setV((cur) => ({ ...cur, ...patch }));
  const places = placeChoices(v.country);
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

  const chooseCountry = (code: string) => {
    // Keep a currency the user typed; follow the country when it was the old country's own.
    const followCurrency = !v.currency || v.currency === currencyOf(v.country);
    set({ country: code, states: [], cities: [], otherCountries: v.otherCountries.filter((c) => c !== code), currency: followCurrency ? (currencyOf(code) ?? v.currency) : v.currency });
  };
  const submit = () =>
    start(async () => {
      const r = await saveJobPreferencesStep(v);
      // On success the action moves to the next step.
      if (r && !r.ok) setErrors(r.errors);
    });

  return (
    <Card title="4. Which jobs should Job Scraper look for?">
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Chips label="Job titles you want *" values={v.titles} onChange={(titles) => set({ titles })} placeholder="e.g. Backend Engineer" hint="Similar titles count too (e.g. Software Engineer for Backend Engineer)." error={errors.titles} testId="pref-titles" />

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">Where</legend>
          <label className="flex flex-col gap-1 text-sm">
            Country *
            <select className={input} value={v.country} onChange={(e) => chooseCountry(e.target.value)} data-testid="pref-country">
              <option value="">Choose a country</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
            <Problem text={errors.country} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Remote jobs
            <select className={input} value={v.remoteScope} onChange={(e) => set({ remoteScope: e.target.value as JobPreferencesInput['remoteScope'] })}>
              <option value="country">Show remote jobs open to {v.country ? countryName(v.country) : 'my country'}</option>
              <option value="worldwide">Show remote jobs from anywhere</option>
              <option value="none">Don’t show remote jobs</option>
            </select>
          </label>
          {v.country && (
            <>
              <Chips label="State or region (optional)" values={v.states} onChange={(states) => set({ states })} options={places.states} placeholder={places.states[0] ? `e.g. ${places.states[0]}` : 'State or region'} hint="Leave empty for the whole country." testId="pref-states" />
              <Chips label="City (optional)" values={v.cities} onChange={(cities) => set({ cities })} options={places.cities} placeholder={places.cities[0] ? `e.g. ${places.cities[0]}` : 'City or town'} hint="Cities narrow the search more than a state." testId="pref-cities" />
            </>
          )}
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Also open to jobs in (optional)
            <select className={input} value="" onChange={(e) => e.target.value && set({ otherCountries: [...new Set([...v.otherCountries, e.target.value])] })}>
              <option value="">Add a country</option>
              {COUNTRIES.filter((c) => c.code !== v.country && !v.otherCountries.includes(c.code)).map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
            {v.otherCountries.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {v.otherCountries.map((c) => (
                  <span key={c} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
                    {countryName(c)}
                    <button type="button" aria-label={`Remove ${countryName(c)}`} onClick={() => set({ otherCountries: v.otherCountries.filter((x) => x !== c) })}>×</button>
                  </span>
                ))}
              </span>
            )}
          </label>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">Work mode *</legend>
            <div className="flex flex-wrap gap-3">
              {WORK_MODES.map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input type="checkbox" checked={v.workModes.includes(m)} onChange={() => set({ workModes: toggle(v.workModes, m) })} /> {MODE_LABELS[m]}
                </label>
              ))}
            </div>
            <Problem text={errors.workModes} />
          </fieldset>
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">Job type *</legend>
            <div className="flex flex-wrap gap-3">
              {EMPLOYMENT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1">
                  <input type="checkbox" checked={v.employmentTypes.includes(t)} onChange={() => set({ employmentTypes: toggle(v.employmentTypes, t) })} /> {TYPE_LABELS[t]}
                </label>
              ))}
            </div>
            <Problem text={errors.employmentTypes} />
          </fieldset>
        </div>

        <fieldset className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <legend className="mb-2 text-sm font-medium">Pay</legend>
          <label className="flex flex-col gap-1 text-sm">
            Expected salary / CTC per year *
            <input className={input} type="number" min={0} step="any" inputMode="numeric" value={v.expectedSalary ?? ''} onChange={(e) => set({ expectedSalary: e.target.value === '' ? null : Number(e.target.value) })} placeholder="e.g. 2400000" data-testid="pref-salary" />
            <Problem text={errors.expectedSalary} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Currency *
            <input className={input} maxLength={3} value={v.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} placeholder="INR" data-testid="pref-currency" />
            <Problem text={errors.currency} />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={v.negotiable} onChange={(e) => set({ negotiable: e.target.checked })} data-testid="pref-negotiable" />
            Negotiable: also show jobs that state lower pay (with a note). When not negotiable, those are filtered out.
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Notice period (optional)
            <input className={input} value={v.noticePeriod ?? ''} onChange={(e) => set({ noticePeriod: e.target.value || null })} placeholder="e.g. 30 days" />
          </label>
        </fieldset>

        <div className="space-y-1 text-sm">
          <label htmlFor="pref-slider" className="font-medium">How closely jobs must match: {v.slider}%</label>
          <input id="pref-slider" type="range" min={SLIDER_RANGE.min} max={SLIDER_RANGE.max} step={5} value={v.slider} onChange={(e) => set({ slider: Number(e.target.value) })} className="w-full" />
          <p className="text-xs text-neutral-500">{describeSlider(v.slider)}</p>
          <Problem text={errors.slider} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Saving…' : 'Save and continue'}</button>
          {Object.keys(errors).length > 0 && <span role="status" className="text-sm text-red-600">Please complete the fields marked above.</span>}
          <Link href="/welcome?step=review" className="text-xs underline">← Back to your profile</Link>
        </div>
      </form>
    </Card>
  );
}
