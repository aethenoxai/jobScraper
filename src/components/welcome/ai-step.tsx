'use client';

import { useActionState, useState } from 'react';
import { disconnectChatGptStep, saveAiStep, signOutClaudeCodeStep } from '@/app/welcome/actions';
import { AiTaskTable } from '@/components/ai-task-table';
import { ClaudeCodeAccount, type ClaudeCodeInfo } from '@/components/claude-code-account';
import { btn, btnPrimary, Card, input, Notice } from '@/components/ui';
import type { AiProvider, AiSettings, AiTask } from '@/server/ai/settings';

export interface KeyInfo {
  provider: 'google' | 'openai' | 'anthropic';
  label: string;
  envVar: string;
  present: boolean;
}

/** Step 1: choose which AI does each job (pre-filled from what is ready); the CV-reading one is tested before going on. */
export function AiStep({
  tasks,
  models,
  notes,
  keys,
  addresses,
  inDocker,
  stateLine,
  chatgpt,
  claudeCode,
  error,
}: {
  /** The routes to start from: the saved ones, or on a fresh install ones filled from the keys and sign-ins that are ready. */
  tasks: AiSettings['tasks'];
  models: Record<AiProvider, string[]>;
  notes: Partial<Record<AiTask, string>>;
  keys: KeyInfo[];
  /** Saved server addresses of the local and compatible servers. */
  addresses: { ollama: string; 'openai-compatible': string };
  inDocker: boolean;
  /** What the saved choices come to, once this step was completed before. */
  stateLine: string | null;
  chatgpt: { email: string | null; needsReconnect: boolean } | null;
  /** Claude Code on this computer (null in Docker, where it can't be used). */
  claudeCode: ClaudeCodeInfo | null;
  /** A message from a sign-in that came back with a problem. */
  error: string | null;
}) {
  const [result, save, pending] = useActionState(saveAiStep, null);
  // Controlled: React resets uncontrolled fields after the action, which would show the old address after a failed test.
  const [urls, setUrls] = useState(addresses);

  return (
    <Card title="1. Choose the AI for each job">
      <form action={save} className="space-y-5">
        {stateLine && <p className="text-sm text-green-700 dark:text-green-400">{stateLine} Change it here, or go on with the next step.</p>}
        {error && <Notice tone="red">{error}</Notice>}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Each job below can use its own AI, or “None” to run offline with simpler rules. It starts from what is ready on this computer: look it over and press Continue. You can change it later in Settings.
        </p>

        <div className="space-y-2 text-sm" data-testid="ai-keys">
          <p>
            <b>API keys</b> are kept only in your <code>.env</code> file and are saved only in your <code>.env</code> file and never shown again:{' '}
            {keys.map((k, i) => (
              <span key={k.envVar}>
                {i > 0 && ' · '}
                {k.label} {k.present ? 'found' : <>missing (<code>{k.envVar}</code>)</>}
              </span>
            ))}
            .
          </p>
          {inDocker ? (
            <p className="text-xs text-neutral-500">In Docker, add a missing key to the <code>.env</code> file next to <code>docker-compose.yml</code> and run <code>docker compose up -d</code>.</p>
          ) : (
            keys.filter((k) => !k.present).map((k) => (
              <label key={k.envVar} className="flex flex-col gap-1">
                Paste your {k.label} key
                <input className={input} type="password" name={`apiKey.${k.provider}`} autoComplete="off" spellCheck={false} placeholder="Optional: saved to .env, never shown again" />
              </label>
            ))
          )}
        </div>

        <div className="space-y-2 text-sm" data-testid="chatgpt-panel">
          <p className="flex flex-wrap items-center gap-3">
            <b>ChatGPT plan</b>
            {chatgpt && !chatgpt.needsReconnect ? (
              <>
                <span>Signed in{chatgpt.email ? ` as ${chatgpt.email}` : ''}.</span>
                <button type="submit" className={btn} formAction={disconnectChatGptStep}>Disconnect</button>
              </>
            ) : (
              <>
                <a className={btn} href="/api/oauth/chatgpt/start">Sign in with ChatGPT</a>
                <span className="text-xs text-neutral-500">{chatgpt?.needsReconnect ? 'OpenAI ended the earlier sign-in: sign in again.' : 'Opens OpenAI’s page; you come back here afterwards.'}</span>
              </>
            )}
          </p>
        </div>

        <div className="space-y-2 text-sm" data-testid="claude-code-panel">
          <b>Claude plan (through your Claude Code)</b>
          {inDocker || !claudeCode ? <p>Claude Code can’t be used from Docker. Use the native install, or another provider.</p> : <ClaudeCodeAccount status={claudeCode} signOut={signOutClaudeCodeStep} />}
          <p className="text-xs text-neutral-500">Plan sign-ins count against your plan’s usage; Job Scraper stops after a daily number of calls so it can’t use it up.</p>
        </div>

        <AiTaskTable tasks={tasks} models={models} notes={notes} />

        <details className="text-sm">
          <summary className="cursor-pointer">Server address (Ollama or an OpenAI-compatible server)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              Ollama
              <input name="ollama.baseUrl" className={input} value={urls.ollama} onChange={(e) => setUrls({ ...urls, ollama: e.target.value })} placeholder="http://127.0.0.1:11434/api" />
            </label>
            <label className="flex flex-col gap-1">
              OpenAI-compatible server
              <input name="openai-compatible.baseUrl" className={input} value={urls['openai-compatible']} onChange={(e) => setUrls({ ...urls, 'openai-compatible': e.target.value })} placeholder="http://127.0.0.1:8080/v1" />
            </label>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btnPrimary} disabled={pending}>{pending ? 'Testing…' : 'Test and continue'}</button>
          <span className="text-xs text-neutral-500">If “Reading your CV” is None, no AI is tested: your CV is read on this computer with simpler rules.</span>
          {result && !result.ok && (
            <span role="status" className="text-sm text-red-600">
              {result.message}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
