'use client';

import { useState, useTransition } from 'react';
import { saveCvAction, type SaveCvResult } from '@/app/applications/actions';
import { btn, btnPrimary, input } from '@/components/ui';
import type { TailoredBullet, TailoredCv } from '@/server/tailoring/model';

export interface EditorItem {
  id: string;
  label: string;
  /** The profile's own bullets for this job/project, which can be added back. */
  masterBullets: Array<{ id: string; text: string }>;
}

type ListKey = 'experience' | 'projects';

/**
 * Edits the wording, order and selection of a tailored CV. Employers, titles, dates and degrees come from the
 * profile and can't be changed here; the server checks every edit against the profile before saving.
 */
export function CvEditor({ applicationId, initial, headlines, items }: { applicationId: number; initial: TailoredCv; headlines: string[]; items: Record<ListKey, EditorItem[]> }) {
  const [cv, setCv] = useState<TailoredCv>(initial);
  const [skills, setSkills] = useState(initial.skills.join(', '));
  const [result, setResult] = useState<SaveCvResult | null>(null);
  const [saving, startSave] = useTransition();

  const setBullets = (key: ListKey, itemId: string, update: (b: TailoredBullet[]) => TailoredBullet[]) =>
    setCv((c) => ({ ...c, [key]: c[key].map((x) => (x.id === itemId ? { ...x, bullets: update(x.bullets) } : x)) }));
  const move = (list: TailoredBullet[], i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const section = (key: ListKey, title: string) =>
    cv[key].length > 0 && (
      <fieldset className="space-y-4">
        <legend className="font-semibold">{title}</legend>
        {cv[key].map((entry) => {
          const meta = items[key].find((x) => x.id === entry.id);
          const unused = meta?.masterBullets.filter((b) => !entry.bullets.some((x) => x.sources.includes(b.id))) ?? [];
          return (
            <div key={entry.id} className="space-y-2" data-testid={`cv-${key}-${entry.id}`}>
              <div className="text-sm font-medium">{meta?.label ?? entry.id}</div>
              {entry.bullets.map((b, i) => (
                <div key={i} className="flex items-start gap-2">
                  <textarea
                    aria-label={`${meta?.label ?? entry.id} bullet ${i + 1}`}
                    className={`${input} min-h-16 flex-1`}
                    value={b.text}
                    onChange={(e) => setBullets(key, entry.id, (list) => list.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                  />
                  <div className="flex flex-col gap-1 text-xs">
                    <button type="button" className="underline" onClick={() => setBullets(key, entry.id, (list) => move(list, i, -1))} aria-label="Move up">↑</button>
                    <button type="button" className="underline" onClick={() => setBullets(key, entry.id, (list) => move(list, i, 1))} aria-label="Move down">↓</button>
                    <button type="button" className="text-red-600 underline" onClick={() => setBullets(key, entry.id, (list) => list.filter((_, k) => k !== i))} aria-label="Remove bullet">✕</button>
                  </div>
                </div>
              ))}
              {unused.length > 0 && (
                <select
                  className={`${input} text-sm`}
                  value=""
                  aria-label={`Add a line from your profile to ${meta?.label ?? entry.id}`}
                  onChange={(e) => {
                    const pick = unused.find((b) => b.id === e.target.value);
                    if (pick) setBullets(key, entry.id, (list) => [...list, { text: pick.text, sources: [pick.id] }]);
                  }}
                >
                  <option value="">+ Add a line from your profile…</option>
                  {unused.map((b) => <option key={b.id} value={b.id}>{b.text.slice(0, 120)}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </fieldset>
    );

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const next: TailoredCv = { ...cv, summary: cv.summary?.trim() ? cv.summary.trim() : null, skills: skills.split(',').map((s) => s.trim()).filter(Boolean) };
        startSave(async () => setResult(await saveCvAction(applicationId, next)));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Headline
          <select className={input} value={cv.headline ?? ''} onChange={(e) => setCv((c) => ({ ...c, headline: e.target.value || null }))}>
            <option value="">No headline</option>
            {headlines.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Skills (most relevant first; only skills from your profile)
          <input className={input} value={skills} onChange={(e) => setSkills(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Summary
        <textarea className={`${input} min-h-24`} value={cv.summary ?? ''} onChange={(e) => setCv((c) => ({ ...c, summary: e.target.value }))} />
      </label>
      {section('experience', 'Experience')}
      {section('projects', 'Projects')}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save CV'}</button>
        <button type="button" className={btn} onClick={() => (setCv(initial), setSkills(initial.skills.join(', ')), setResult(null))}>Undo changes</button>
        {result && <span role="status" className={`text-sm ${result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{result.message}</span>}
      </div>
      {result && result.problems.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-red-600" aria-label="Problems">
          {result.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </form>
  );
}
