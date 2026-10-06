import type { Metadata } from 'next';
import { z } from 'zod';
import { AiSettingsForm } from '@/components/ai-settings-form';
import { AiProvidersCard, type ProviderCardRow } from '@/components/ai-providers-card';
import { Card, PageHeader } from '@/components/ui';
import { AI_PROVIDERS, AI_SETTINGS_KEY, AI_TASKS, migrateAiSettings, type AiProvider, type AiTask } from '@/server/ai';
import { chatGptAccount } from '@/server/ai/chatgpt-auth';
import { claudeCodeStatus } from '@/server/ai/claude-code';
import { listModels, type ModelList } from '@/server/ai/models';
import { aiStateLine, limitReached, modelNote, providerRows } from '@/server/ai/provider-view';
import { privacyLines } from '@/server/ai/privacy';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';

export const metadata: Metadata = { title: 'AI provider' };

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage({ searchParams }: PageProps<'/settings/ai'>) {
  const { ai, settings } = getAppContext();
  const { error } = await searchParams;
  const current = migrateAiSettings(settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), liveEnv());
  const inDocker = process.env.JOB_SCRAPER_IN_DOCKER === 'true';
  const claudeCode = inDocker ? null : await claudeCodeStatus();
  const env = liveEnv();
  const statuses = AI_PROVIDERS.map((p) => ai.providerStatus(p));
  // listModels never throws and falls back to the built-in list (and doesn't call out without a key or address).
  const lists = Object.fromEntries(await Promise.all(statuses.map(async (s) => [s.provider, await listModels(s.provider, { env, baseUrl: s.baseUrl })] as const))) as Record<AiProvider, ModelList>;
  const rows: ProviderCardRow[] = providerRows(statuses, current).map((r) => ({
    ...r,
    modelNote: r.keyPresent && (!r.needsBaseUrl || r.baseUrl) ? modelNote(r.provider, lists[r.provider]) : null,
  }));
  const models = Object.fromEntries(AI_PROVIDERS.map((p) => [p, lists[p].models])) as Record<AiProvider, string[]>;
  const taskStatuses = AI_TASKS.map((t) => ai.taskStatus(t));
  const notes = Object.fromEntries(taskStatuses.filter((t) => t.provider !== 'none' && !t.configured && t.reason).map((t) => [t.task, t.reason])) as Partial<Record<AiTask, string>>;
  const privacy = privacyLines(taskStatuses, { ...Object.fromEntries(statuses.map((s) => [s.provider, s.baseUrl])), ollama: statuses.find((s) => s.provider === 'ollama')?.baseUrl ?? env.OLLAMA_BASE_URL ?? null });
  const stateLine = aiStateLine(taskStatuses, new Set(statuses.filter(limitReached).map((s) => s.provider)));
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="AI provider" subtitle="Job Scraper uses your own AI account: an API key (kept only in your .env file, never shown or stored in the database), your ChatGPT plan, or your own Claude Code." />
      <p role="status" data-testid="ai-state" className="rounded border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">{stateLine}</p>
      {typeof error === 'string' && <p role="alert" className="rounded border border-red-400 px-3 py-2 text-sm">{error.slice(0, 300)}</p>}
      <Card title="Providers">
        <AiProvidersCard rows={rows} inDocker={inDocker} chatgpt={chatGptAccount(settings)} claudeCode={claudeCode} />
      </Card>
      <Card title="What each task uses">
        <AiSettingsForm tasks={current.tasks} models={models} notes={notes} />
      </Card>
      <Card title="What leaves your machine">
        <p className="mb-2 text-sm text-neutral-600 dark:text-neutral-400">
          Each task goes to the provider you chose for it, and only its own data is sent. Nothing is sent for a task set to None, or to Ollama on your own computer.
        </p>
        <ul className="space-y-1 text-sm" data-testid="ai-privacy">
          {privacy.map((l) => (
            <li key={l.task}><span className="font-medium">{l.title}:</span> {l.notReady ? 'not set up yet, so it runs offline on this computer for now and sends nothing' : l.local ? 'nothing leaves your computer' : `sends ${l.data} to ${l.destination}`}.</li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Text you wrote inside your summary, bullets or project descriptions is sent as you wrote it: if you put an email or phone number there, it goes too. With None, Job Scraper works offline with simpler, rule-based extraction and matching. Each provider’s own privacy terms apply to what it receives.</p>
      </Card>
    </div>
  );
}
