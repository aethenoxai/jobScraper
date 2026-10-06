'use client';

import { useActionState, useState, useTransition } from 'react';
import { disconnectChatGptProvider, saveProviders, signOutClaudeCodeProvider, testProviderConnection, type ProviderActionResult } from '@/app/(app)/settings/ai/providers-actions';
import { ClaudeCodeAccount, type ClaudeCodeInfo } from '@/components/claude-code-account';
import { Badge, btn, btnPrimary, input } from '@/components/ui';
import type { ProviderRow } from '@/server/ai/provider-view';

export interface ProviderCardRow extends ProviderRow {
  /** Plain-words note when the live model list couldn't be fetched; null otherwise. */
  modelNote: string | null;
}

/** One row per AI provider: key state (from .env), address, daily limit, use today, and a connection test. */
export function AiProvidersCard({ rows, inDocker, chatgpt, claudeCode }: { rows: ProviderCardRow[]; inDocker: boolean; chatgpt: { email: string | null; needsReconnect: boolean } | null; claudeCode: ClaudeCodeInfo | null }) {
  const [saved, save, saving] = useActionState(saveProviders, null);
  const [tests, setTests] = useState<Record<string, ProviderActionResult>>({});
  const [testing, startTest] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <form action={save} className="space-y-4">
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {rows.map((r) => {
          const p = r.provider;
          const result = tests[p];
          return (
            <li key={p} className="space-y-2 py-3 text-sm" data-testid={`provider-${p}`}>
              <div className="flex flex-wrap items-center gap-2">
                <b>{r.label}</b>
                {r.keyEnvVar && p !== 'openai-compatible' && (r.keyPresent ? <Badge tone="green">Key set in .env</Badge> : <Badge tone="amber">No key</Badge>)}
              </div>
              {r.keyEnvVar && !r.keyPresent && (
                <p className="text-neutral-600 dark:text-neutral-400">
                  Add <code>{r.keyEnvVar}</code> to your .env file{inDocker ? ' (next to docker-compose.yml), then run "docker compose up -d"' : ' and restart Job Scraper'}. Keys are never typed or shown here.
                </p>
              )}
              {r.warning && <p role="alert" data-testid={`provider-warning-${p}`} className="rounded border border-amber-400 px-3 py-2">{r.warning}</p>}
              {p === 'chatgpt' && (
                <p className="flex flex-wrap items-center gap-3" data-testid="chatgpt-account">
                  {chatgpt && !chatgpt.needsReconnect ? (
                    <>
                      Signed in{chatgpt.email ? ` as ${chatgpt.email}` : ''}.
                      <button type="button" className={btn} onClick={() => void disconnectChatGptProvider()}>Disconnect</button>
                    </>
                  ) : (
                    <a className={btn} href="/api/oauth/chatgpt/start?from=settings">Sign in with ChatGPT</a>
                  )}
                </p>
              )}
              {p === 'claude-code' && (
                <div data-testid="claude-code-status">
                  {claudeCode ? <ClaudeCodeAccount status={claudeCode} signOut={signOutClaudeCodeProvider} /> : 'Claude Code can’t be used from Docker.'}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {r.needsBaseUrl && (
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    Server address
                    <input name={`${p}.baseUrl`} className={input} defaultValue={r.baseUrl ?? ''} placeholder={p === 'ollama' ? 'http://127.0.0.1:11434/api' : 'https://your-server/v1'} />
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  {r.limitKind === 'calls' ? 'AI calls per day (empty = no limit)' : 'Daily budget, USD estimate (empty = no limit)'}
                  <input name={`${p}.limit`} type="number" min={r.limitKind === 'calls' ? 1 : 0} step={r.limitKind === 'calls' ? 1 : 'any'} className={input} defaultValue={r.limit ?? ''} />
                </label>
                <p className="self-end" data-testid={`provider-used-${p}`}>Used today: {r.usedToday}</p>
              </div>
              {r.modelNote && <p className="text-neutral-600 dark:text-neutral-400" data-testid={`provider-models-${p}`}>{r.modelNote}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={btn}
                  disabled={testing}
                  data-testid={`test-${p}`}
                  onClick={(e) => {
                    const address = (e.currentTarget.form?.elements.namedItem(`${p}.baseUrl`) as HTMLInputElement | null)?.value ?? '';
                    setBusy(p);
                    startTest(async () => {
                      try {
                        const out = await testProviderConnection(p, address);
                        setTests((t) => ({ ...t, [p]: out }));
                      } catch {
                        setTests((t) => ({ ...t, [p]: { ok: false, message: 'The test could not run. Check the logs.' } }));
                      } finally {
                        setBusy(null);
                      }
                    });
                  }}
                >
                  {busy === p ? 'Testing…' : 'Test connection'}
                </button>
                {result && <span role="status" className={result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{result.message}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={saving}>Save providers</button>
        {saved && <span role="status" data-testid="providers-saved" className={`text-sm ${saved.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{saved.message}</span>}
      </div>
    </form>
  );
}
