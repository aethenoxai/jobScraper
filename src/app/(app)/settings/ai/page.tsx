import type { Metadata } from 'next';
import { AiSettingsForm } from '@/components/ai-settings-form';
import { AiProvidersCard, type ProviderCardRow } from '@/components/ai-providers-card';
import { Card, PageHeader } from '@/components/ui';
import { AI_PROVIDERS, AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS } from '@/server/ai';
import { chatGptAccount } from '@/server/ai/chatgpt-auth';
import { claudeCodeStatus } from '@/server/ai/claude-code';
import { listModels } from '@/server/ai/models';
import { modelNote, providerRows } from '@/server/ai/provider-view';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';

export const metadata: Metadata = { title: 'AI provider' };

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage({ searchParams }: PageProps<'/settings/ai'>) {
  const { ai, settings } = getAppContext();
  const { error } = await searchParams;
  const current = settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);
  const inDocker = process.env.JOB_SCRAPER_IN_DOCKER === 'true';
  const claudeCode = inDocker ? null : await claudeCodeStatus();
  const env = liveEnv();
  const rows: ProviderCardRow[] = await Promise.all(
    providerRows(AI_PROVIDERS.map((p) => ai.providerStatus(p)), current).map(async (r) => ({
      ...r,
      // Only ask a provider that could answer; listModels never throws and falls back to the built-in list.
      modelNote: r.keyPresent && (!r.needsBaseUrl || r.baseUrl) ? modelNote(r.provider, await listModels(r.provider, { env, baseUrl: r.baseUrl })) : null,
    })),
  );
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="AI provider" subtitle="Job Scraper uses your own AI account: an API key (kept only in your .env file, never shown or stored in the database), your ChatGPT plan, or your own Claude Code." />
      {typeof error === 'string' && <p role="alert" className="rounded border border-red-400 px-3 py-2 text-sm">{error.slice(0, 300)}</p>}
      <Card title="Providers">
        <AiProvidersCard rows={rows} inDocker={inDocker} chatgpt={chatGptAccount(settings)} claudeCode={claudeCode} />
      </Card>
      <Card title="Configuration">
        <AiSettingsForm initial={current} chatgpt={chatGptAccount(settings)} claudeCode={claudeCode} />
      </Card>
      <Card title="What leaves your machine">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          When AI is enabled, the text of your CV and of job descriptions is sent to the provider you choose, so it can extract, match and tailor. With ChatGPT it goes to OpenAI under your ChatGPT plan; with Claude Code, to Anthropic through your own Claude Code. With Ollama, everything stays on your computer. With “None”, Job Scraper works offline with simpler, rule-based extraction and matching.
        </p>
      </Card>
    </div>
  );
}
