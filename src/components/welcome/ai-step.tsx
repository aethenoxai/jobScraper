'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { connectAiStep, type StepResult } from '@/app/welcome/actions';
import { btnPrimary, Card, input } from '@/components/ui';
import { DEFAULT_MODELS, KEY_ENV_VAR, MODEL_CHOICES, PROVIDER_LABELS, type AiProvider, type AiSettings } from '@/server/ai/settings';

type Provider = Exclude<AiProvider, 'none'>;
const PROVIDERS: Array<{ id: Provider; hint: string; keyUrl?: string }> = [
  { id: 'openai', hint: 'GPT models with an OpenAI API key.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', hint: 'Claude models with an Anthropic API key.', keyUrl: 'https://platform.claude.com/' },
  { id: 'google', hint: 'Gemini models with a Google AI Studio key.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'ollama', hint: 'Models running on this computer: free, nothing leaves it.' },
  { id: 'openai-compatible', hint: 'Any server that speaks the OpenAI API (LM Studio, vLLM, a gateway…).' },
];

const modelsFor = (p: Provider, initial: AiSettings) =>
  p === initial.provider ? { fast: initial.fastModel ?? DEFAULT_MODELS[p].fast ?? '', quality: initial.qualityModel ?? DEFAULT_MODELS[p].quality ?? '' } : { fast: DEFAULT_MODELS[p].fast ?? '', quality: DEFAULT_MODELS[p].quality ?? '' };

/** Step 1: choose the AI that reads the CV and matches jobs; it is tested before going on. */
export function AiStep({ initial, savedKeys, inDocker, connected }: { initial: AiSettings; savedKeys: Record<string, boolean>; inDocker: boolean; connected: string | null }) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(initial.provider === 'none' ? 'openai' : initial.provider);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [models, setModels] = useState(modelsFor(provider, initial));
  const [result, setResult] = useState<StepResult | null>(null);
  const [pending, start] = useTransition();
  const keyVar = KEY_ENV_VAR[provider];
  const needsUrl = provider === 'ollama' || provider === 'openai-compatible';
  const keySaved = !!savedKeys[provider];

  const choose = (p: Provider) => {
    setProvider(p);
    setModels(modelsFor(p, initial));
    setApiKey('');
    setResult(null);
  };
  const submit = () =>
    start(async () => {
      const form = new FormData();
      Object.entries({ provider, apiKey, baseUrl, fastModel: models.fast, qualityModel: models.quality }).forEach(([k, v]) => form.set(k, v));
      const r = await connectAiStep(form);
      setResult(r);
      if (r.ok) {
        setApiKey('');
        router.push('/welcome');
        router.refresh();
      }
    });

  return (
    <Card title="1. Choose the AI that reads your CV and matches jobs">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {connected && <p className="text-sm text-green-700 dark:text-green-400">Connected: {connected}. Change it here, or go on with the next step.</p>}
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">Provider</legend>
          {PROVIDERS.map((p) => (
            <label key={p.id} className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${provider === p.id ? 'border-neutral-900 dark:border-neutral-100' : 'border-neutral-200 dark:border-neutral-800'}`}>
              <input type="radio" name="provider" value={p.id} checked={provider === p.id} onChange={() => choose(p.id)} />
              <span>
                <span className="font-medium">{PROVIDER_LABELS[p.id]}</span>
                <span className="block text-xs text-neutral-500">{p.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {keyVar &&
          (inDocker ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              In Docker, add <code>{keyVar}=…</code> to the <code>.env</code> file next to <code>docker-compose.yml</code> and run <code>docker compose up -d</code>; then test here.{keySaved && ' A key is already set.'}
            </p>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              API key{provider === 'openai-compatible' ? ' (if your server needs one)' : ''}
              <input
                className={input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keySaved ? 'A key is saved in .env: leave empty to use it' : 'Paste your key'}
              />
              <span className="text-xs text-neutral-500">
                Saved only in your <code>.env</code> file ({keyVar}), never in the database.{' '}
                {PROVIDERS.find((p) => p.id === provider)?.keyUrl && (
                  <a className="underline" href={PROVIDERS.find((p) => p.id === provider)!.keyUrl} target="_blank" rel="noreferrer">Get a key</a>
                )}
              </span>
            </label>
          ))}

        {needsUrl && (
          <label className="flex flex-col gap-1 text-sm">
            Server address
            <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434/api' : 'http://127.0.0.1:8080/v1'} />
          </label>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Model for CVs and cover letters
            <input className={input} list="quality-models" value={models.quality} onChange={(e) => setModels({ ...models, quality: e.target.value })} placeholder="model name" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Model for reading and matching jobs
            <input className={input} list="fast-models" value={models.fast} onChange={(e) => setModels({ ...models, fast: e.target.value })} placeholder="model name" />
          </label>
          <datalist id="quality-models">{MODEL_CHOICES[provider].map((m) => <option key={m} value={m} />)}</datalist>
          <datalist id="fast-models">{MODEL_CHOICES[provider].map((m) => <option key={m} value={m} />)}</datalist>
          <p className="text-xs text-neutral-500 sm:col-span-2">Pre-filled with good defaults: matching runs often, so a smaller model keeps the cost down.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Testing…' : 'Test and continue'}</button>
          {result && (
            <span role="status" className={`text-sm ${result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>
              {result.message}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
