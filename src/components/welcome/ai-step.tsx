'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { connectAiStep, disconnectChatGptStep, type StepResult } from '@/app/welcome/actions';
import { btn, btnPrimary, Card, input, Notice } from '@/components/ui';
import { DEFAULT_MODELS, KEY_ENV_VAR, MODEL_CHOICES, PROVIDER_LABELS, type AiProvider, type AiSettings } from '@/server/ai/settings';

type Provider = Exclude<AiProvider, 'none'>;
const PROVIDERS: Array<{ id: Provider; hint: string; keyUrl?: string }> = [
  { id: 'chatgpt', hint: 'Use your ChatGPT Plus or Pro plan: sign in with OpenAI, no API key.' },
  { id: 'claude-code', hint: 'Use your Claude Pro or Max plan through the Claude Code installed on this computer.' },
  { id: 'openai', hint: 'GPT models with an OpenAI API key.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', hint: 'Claude models with an Anthropic API key.', keyUrl: 'https://platform.claude.com/' },
  { id: 'google', hint: 'Gemini models with a Google AI Studio key.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'ollama', hint: 'Models running on this computer: free, nothing leaves it.' },
  { id: 'openai-compatible', hint: 'Any server that speaks the OpenAI API (LM Studio, vLLM, a gateway…).' },
];

const modelsFor = (p: Provider, initial: AiSettings) =>
  p === initial.provider ? { fast: initial.fastModel ?? DEFAULT_MODELS[p].fast ?? '', quality: initial.qualityModel ?? DEFAULT_MODELS[p].quality ?? '' } : { fast: DEFAULT_MODELS[p].fast ?? '', quality: DEFAULT_MODELS[p].quality ?? '' };

export interface ClaudeCodeInfo {
  installed: boolean;
  loggedIn: boolean;
  message: string;
}

/** Step 1: choose the AI that reads the CV and matches jobs; it is tested before going on. */
export function AiStep({
  initial,
  savedKeys,
  inDocker,
  connected,
  chatgpt,
  claudeCode,
  error,
  justSignedIn = false,
}: {
  initial: AiSettings;
  savedKeys: Record<string, boolean>;
  inDocker: boolean;
  connected: string | null;
  /** The ChatGPT account signed in, if any. */
  chatgpt: { email: string | null; needsReconnect: boolean } | null;
  /** Claude Code on this computer (null in Docker, where it can't be used). */
  claudeCode: ClaudeCodeInfo | null;
  /** A message from a sign-in that came back with a problem. */
  error: string | null;
  /** Back from signing in with ChatGPT: that's the provider being set up. */
  justSignedIn?: boolean;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(justSignedIn ? 'chatgpt' : initial.provider === 'none' ? 'openai' : initial.provider);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [models, setModels] = useState(() => modelsFor(justSignedIn ? 'chatgpt' : initial.provider === 'none' ? 'openai' : initial.provider, initial));
  const [result, setResult] = useState<StepResult | null>(null);
  const [pending, start] = useTransition();
  const keyVar = KEY_ENV_VAR[provider];
  const needsUrl = provider === 'ollama' || provider === 'openai-compatible';
  const keySaved = !!savedKeys[provider];
  const blocked = (provider === 'chatgpt' && (!chatgpt || chatgpt.needsReconnect)) || (provider === 'claude-code' && !claudeCode?.loggedIn);

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
        {error && <Notice tone="red">{error}</Notice>}
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

        {provider === 'chatgpt' && (
          <div className="space-y-2 text-sm" data-testid="chatgpt-panel">
            {chatgpt && !chatgpt.needsReconnect ? (
              <p className="flex flex-wrap items-center gap-3">
                <span>Signed in{chatgpt.email ? ` as ${chatgpt.email}` : ''}.</span>
                <button type="button" className={btn} onClick={() => start(async () => void (await disconnectChatGptStep()))}>Disconnect</button>
              </p>
            ) : (
              <p className="flex flex-wrap items-center gap-3">
                <a className={btnPrimary} href="/api/oauth/chatgpt/start">Sign in with ChatGPT</a>
                <span className="text-xs text-neutral-500">{chatgpt?.needsReconnect ? 'OpenAI ended the earlier sign-in: sign in again.' : 'Opens OpenAI’s page; you come back here afterwards.'}</span>
              </p>
            )}
            <p className="text-xs text-neutral-500">Calls count against your ChatGPT plan’s usage. Job Scraper stops after a daily number of calls (Settings → AI provider) so it can’t use up your plan.</p>
          </div>
        )}

        {provider === 'claude-code' && (
          <div className="space-y-2 text-sm" data-testid="claude-code-panel">
            {inDocker || !claudeCode ? (
              <p>Claude Code can’t be used from Docker. Use the native install, or another provider.</p>
            ) : (
              <>
                <p className={claudeCode.loggedIn ? 'text-green-700 dark:text-green-400' : ''}>{claudeCode.message}</p>
                {!claudeCode.loggedIn && (
                  <button type="button" className={btn} onClick={() => router.refresh()}>Check again</button>
                )}
              </>
            )}
            <p className="text-xs text-neutral-500">
              Job Scraper runs your own Claude Code (<code>claude -p</code>) and never sees your Claude password or tokens. Calls count against your Claude plan’s limits, and Job Scraper stops after a daily number of calls. Anthropic sets the terms for using Claude Code from other tools and may change them.
            </p>
          </div>
        )}

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
          <button type="submit" className={btnPrimary} disabled={pending || blocked}>{pending ? 'Testing…' : 'Test and continue'}</button>
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
