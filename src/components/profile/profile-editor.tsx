'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { saveProfileData } from '@/app/profiles/actions';
import { btn, btnPrimary, input } from '@/components/ui';
import { parseCsv, toBullets } from '@/lib/lists';
import { CAREER_LEVELS, SKILL_CATEGORIES, type ProfileData } from '@/server/profile/model';

type P = ProfileData;
const orNull = (v: string) => (v.trim() === '' ? null : v);
const csv = parseCsv;

function Field({ label, missing, children }: { label: string; missing?: boolean; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex items-center gap-2">
        {label}
        {missing && <span className="rounded bg-amber-100 px-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">Missing, enter manually</span>}
      </span>
      {children}
    </label>
  );
}

function Text({ label, value, onChange, important, multiline, placeholder, type = 'text' }: { label: string; value: string | null; onChange: (v: string | null) => void; important?: boolean; multiline?: boolean; placeholder?: string; type?: 'text' | 'email' | 'tel' }) {
  const missing = important && !value;
  const cls = `${input} ${missing ? 'border-amber-400' : ''}`;
  return (
    <Field label={label} missing={missing}>
      {multiline ? (
        <textarea className={cls} rows={3} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(orNull(e.target.value))} />
      ) : (
        <input type={type} className={cls} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(orNull(e.target.value))} />
      )}
    </Field>
  );
}

function TriState({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <Field label={label}>
      <select className={input} value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
        <option value="">Not specified</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </Field>
  );
}

function ListSection<T>({ title, items, onChange, blank, render }: { title: string; items: T[]; onChange: (items: T[]) => void; blank: () => T; render: (item: T, update: (patch: Partial<T>) => void) => ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 font-semibold">{title}</legend>
      {items.length === 0 && <p className="text-sm text-amber-700 dark:text-amber-400">None yet.</p>}
      {items.map((item, i) => (
        <div key={(item as { id?: string }).id || `new-${i}`} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          {render(item, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}
          <button type="button" className={`${btn} mt-2`} onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className={btn} onClick={() => onChange([...items, blank()])}>Add</button>
    </fieldset>
  );
}

/** A comma-separated list input that keeps what the user typed and updates the list on every keystroke. */
function CsvInput({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [raw, setRaw] = useState(value.join(', '));
  return (
    <Field label={label}>
      <input
        className={input}
        value={raw}
        placeholder={placeholder}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(csv(e.target.value));
        }}
      />
    </Field>
  );
}

export function ProfileEditor({ profileId, initial }: { profileId: number; initial: P }) {
  const [p, setP] = useState<P>(initial);
  const [status, setStatus] = useState<{ ok: boolean; message?: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<P>) => setP((cur) => ({ ...cur, ...patch }));
  const setPersonal = (patch: Partial<P['personal']>) => setP((cur) => ({ ...cur, personal: { ...cur.personal, ...patch } }));
  const setApp = (patch: Partial<P['application']>) => setP((cur) => ({ ...cur, application: { ...cur.application, ...patch } }));

  const save = () =>
    start(async () => {
      const result = await saveProfileData(profileId, p);
      if (result.data) setP(result.data); // adopt ids assigned on the server
      setStatus(result);
    });

  return (
    <form
      className="space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Personal</legend>
        <Text label="Full name" value={p.personal.fullName} onChange={(v) => setPersonal({ fullName: v })} important />
        <Text label="Email" type="email" value={p.personal.email} onChange={(v) => setPersonal({ email: v })} important />
        <Text label="Phone" type="tel" value={p.personal.phone} onChange={(v) => setPersonal({ phone: v })} important />
        <Text label="Location" value={p.personal.location} onChange={(v) => setPersonal({ location: v })} important />
        <Text label="Country" value={p.personal.country} onChange={(v) => setPersonal({ country: v })} />
        <Text label="Time zone" value={p.personal.timezone} onChange={(v) => setPersonal({ timezone: v })} placeholder="e.g. Asia/Kolkata" />
      </fieldset>

      <ListSection
        title="Links (LinkedIn, GitHub, portfolio…)"
        items={p.personal.links}
        onChange={(links) => setPersonal({ links })}
        blank={() => ({ id: '', label: 'Link', url: '' })}
        render={(l, u) => (
          <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
            <input aria-label="Link label" className={input} value={l.label} onChange={(e) => u({ label: e.target.value })} />
            <input aria-label="Link URL" className={input} value={l.url} onChange={(e) => u({ url: e.target.value })} />
          </div>
        )}
      />

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Professional</legend>
        <Text label="Current title / profession" value={p.headline} onChange={(v) => set({ headline: v })} important />
        <CsvInput label="Target job titles (comma separated)" value={p.targetTitles} onChange={(targetTitles) => set({ targetTitles })} />
        <CsvInput label="Previous titles (comma separated)" value={p.previousTitles} onChange={(previousTitles) => set({ previousTitles })} />
        <Field label="Years of experience" missing={p.yearsExperience === null}>
          <input className={input} type="number" min={0} max={70} step="any" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Text label="Industry" value={p.industry} onChange={(v) => set({ industry: v })} />
        <Text label="Domain" value={p.domain} onChange={(v) => set({ domain: v })} />
        <Field label="Career level">
          <select className={input} value={p.careerLevel ?? ''} onChange={(e) => set({ careerLevel: (e.target.value || null) as P['careerLevel'] })}>
            <option value="">Not specified</option>
            {CAREER_LEVELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Text label="Professional summary" value={p.summary} onChange={(v) => set({ summary: v })} multiline important />
        </div>
      </fieldset>

      <ListSection
        title="Work experience"
        items={p.experience}
        onChange={(experience) => set({ experience })}
        blank={() => ({ id: '', title: null, company: null, location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [] })}
        render={(e, u) => (
          <div className="grid gap-2 sm:grid-cols-2">
            <Text label="Title" value={e.title} onChange={(v) => u({ title: v })} />
            <Text label="Company" value={e.company} onChange={(v) => u({ company: v })} />
            <Text label="Location" value={e.location} onChange={(v) => u({ location: v })} />
            <div className="grid grid-cols-2 gap-2">
              <Text label="Start (YYYY-MM)" value={e.startDate} onChange={(v) => u({ startDate: v })} />
              <Text label="End (YYYY-MM)" value={e.current ? null : e.endDate} onChange={(v) => u({ endDate: v })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={e.current} onChange={(ev) => u({ current: ev.target.checked, endDate: ev.target.checked ? null : e.endDate })} /> I currently work here
            </label>
            <div className="sm:col-span-2">
              <Text label="Role summary" value={e.summary} onChange={(v) => u({ summary: v })} multiline />
            </div>
            <div className="sm:col-span-2">
              <Field label="Achievements and responsibilities (one per line)">
                <textarea className={input} rows={4} defaultValue={e.bullets.map((b) => b.text).join('\n')} onBlur={(ev) => u({ bullets: toBullets(ev.target.value, e.bullets) })} />
              </Field>
            </div>
          </div>
        )}
      />

      <ListSection
        title="Education"
        items={p.education}
        onChange={(education) => set({ education })}
        blank={() => ({ id: '', institution: null, degree: null, field: null, startDate: null, endDate: null, grade: null })}
        render={(e, u) => (
          <div className="grid gap-2 sm:grid-cols-3">
            <Text label="Institution" value={e.institution} onChange={(v) => u({ institution: v })} />
            <Text label="Degree" value={e.degree} onChange={(v) => u({ degree: v })} />
            <Text label="Field" value={e.field} onChange={(v) => u({ field: v })} />
            <Text label="Start (YYYY)" value={e.startDate} onChange={(v) => u({ startDate: v })} />
            <Text label="End (YYYY)" value={e.endDate} onChange={(v) => u({ endDate: v })} />
            <Text label="Grade" value={e.grade} onChange={(v) => u({ grade: v })} />
          </div>
        )}
      />

      <fieldset className="space-y-2">
        <legend className="mb-2 font-semibold">Skills, technologies and tools</legend>
        {p.skills.length === 0 && <p className="text-sm text-amber-700 dark:text-amber-400">No skills yet.</p>}
        <ul className="flex flex-wrap gap-2">
          {p.skills.map((s, i) => (
            <li key={s.id || i} className="flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700">
              {s.name}
              <select aria-label={`Category of ${s.name}`} className="bg-transparent text-xs" value={s.category} onChange={(e) => set({ skills: p.skills.map((x, j) => (j === i ? { ...x, category: e.target.value as typeof s.category } : x)) })}>
                {SKILL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => set({ skills: p.skills.filter((_, j) => j !== i) })}>×</button>
            </li>
          ))}
        </ul>
        <input
          className={input}
          aria-label="Add skills"
          placeholder="Add skills, comma separated, then press Enter"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const names = csv(e.currentTarget.value).filter((n) => !p.skills.some((s) => s.name.toLowerCase() === n.toLowerCase()));
            set({ skills: [...p.skills, ...names.map((name) => ({ id: '', name, category: 'skill' as const }))] });
            e.currentTarget.value = '';
          }}
        />
      </fieldset>

      <ListSection
        title="Projects"
        items={p.projects}
        onChange={(projects) => set({ projects })}
        blank={() => ({ id: '', name: 'New project', description: null, url: null, technologies: [], bullets: [] })}
        render={(pr, u) => (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name"><input className={input} value={pr.name} onChange={(e) => u({ name: e.target.value })} /></Field>
            <Text label="URL" value={pr.url} onChange={(v) => u({ url: v })} />
            <div className="sm:col-span-2"><Text label="Description" value={pr.description} onChange={(v) => u({ description: v })} multiline /></div>
            <CsvInput label="Technologies (comma separated)" value={pr.technologies} onChange={(technologies) => u({ technologies })} />
            <Field label="Highlights (one per line)"><textarea className={input} rows={2} defaultValue={pr.bullets.map((b) => b.text).join('\n')} onBlur={(e) => u({ bullets: toBullets(e.target.value, pr.bullets) })} /></Field>
          </div>
        )}
      />

      <ListSection
        title="Certifications"
        items={p.certifications}
        onChange={(certifications) => set({ certifications })}
        blank={() => ({ id: '', name: 'New certification', issuer: null, date: null })}
        render={(c, u) => (
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Name"><input className={input} value={c.name} onChange={(e) => u({ name: e.target.value })} /></Field>
            <Text label="Issuer" value={c.issuer} onChange={(v) => u({ issuer: v })} />
            <Text label="Date (YYYY-MM)" value={c.date} onChange={(v) => u({ date: v })} />
          </div>
        )}
      />

      <ListSection
        title="Languages"
        items={p.languages}
        onChange={(languages) => set({ languages })}
        blank={() => ({ id: '', name: 'Language', proficiency: null })}
        render={(l, u) => (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Language"><input className={input} value={l.name} onChange={(e) => u({ name: e.target.value })} /></Field>
            <Text label="Proficiency" value={l.proficiency} onChange={(v) => u({ proficiency: v })} />
          </div>
        )}
      />

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Application details</legend>
        <Text label="Work authorization" value={p.application.workAuthorization} onChange={(v) => setApp({ workAuthorization: v })} important placeholder="e.g. Indian citizen; UK Skilled Worker visa" />
        <Text label="Visa status" value={p.application.visaStatus} onChange={(v) => setApp({ visaStatus: v })} />
        <Text label="Notice period" value={p.application.noticePeriod} onChange={(v) => setApp({ noticePeriod: v })} important placeholder="e.g. 30 days" />
        <Text label="Current salary" value={p.application.currentSalary} onChange={(v) => setApp({ currentSalary: v })} />
        <Text label="Expected salary" value={p.application.expectedSalary} onChange={(v) => setApp({ expectedSalary: v })} important />
        <TriState label="Currently employed" value={p.application.currentlyEmployed} onChange={(v) => setApp({ currentlyEmployed: v })} />
        <TriState label="Willing to relocate" value={p.application.relocation} onChange={(v) => setApp({ relocation: v })} />
        <TriState label="Willing to travel" value={p.application.travel} onChange={(v) => setApp({ travel: v })} />
      </fieldset>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-neutral-200 bg-[var(--background)] py-3 dark:border-neutral-800">
        <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Saving…' : 'Save profile'}</button>
        {status && <span role="status" className={`text-sm ${status.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{status.message}</span>}
      </div>
    </form>
  );
}
