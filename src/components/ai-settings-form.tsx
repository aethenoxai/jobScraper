'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { saveAiSettings, testAiConnection, type AiActionResult } from '@/app/settings/ai/actions';
import { btn, btnPrimary, input } from '@/components/ui';
import { AI_PROVIDERS, DEFAULT_MODELS, PROVIDER_LABELS, type AiSettings } from '@/server/ai/settings';

export function AiSettingsForm({ initial }: { initial: AiSettings }) {
  const [provider, setProvider] = useState(initial.provider);
  const [state, action, pending] = useActionState(saveAiSettings, null);
  const [test, setTest] = useState<AiActionResult | null>(null);
  const [testing, startTest] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const defaults = provider === 'none' ? null : DEFAULT_MODELS[provider];
  const needsBaseUrl = provider === 'ollama' || provider === 'openai-compatible';

  return (
    <div className="space-y-4">
      <form
        ref={form}
        action={(data) => {
          // An earlier test result described other settings.
          setTest(null);
          action(data);
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Provider
          <select name="provider" className={input} value={provider} onChange={(e) => {
              setProvider(e.target.value as AiSettings['provider']);
              setTest(null);
            }}>
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>
        {provider !== 'none' && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              Fast model (extraction, matching)
              <input name="fastModel" className={input} defaultValue={initial.fastModel ?? ''} placeholder={defaults?.fast ?? 'model name'} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Quality model (CVs, cover letters)
              <input name="qualityModel" className={input} defaultValue={initial.qualityModel ?? ''} placeholder={defaults?.quality ?? 'model name'} />
            </label>
            {needsBaseUrl && (
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Base URL
                <input name="baseUrl" className={input} defaultValue={initial.baseUrl ?? ''} placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434/api' : 'https://your-server/v1'} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              Daily budget (USD, estimated; empty = no limit)
              <input name="dailyBudgetUsd" type="number" min={0} step="any" className={input} defaultValue={initial.dailyBudgetUsd ?? ''} />
            </label>
          </>
        )}
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className={btnPrimary} disabled={pending}>Save</button>
          {state && <span role="status" className={`text-sm ${state.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{state.message}</span>}
        </div>
      </form>
      <div className="flex items-center gap-3">
        <button type="button" className={btn} disabled={testing} onClick={() => startTest(async () => setTest(await testAiConnection(new FormData(form.current ?? undefined))))}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {test && <span role="status" className={`text-sm ${test.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{test.message}</span>}
      </div>
    </div>
  );
}
