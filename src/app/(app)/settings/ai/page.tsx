import type { Metadata } from 'next';
import { AiSettingsForm } from '@/components/ai-settings-form';
import { Badge, Card, PageHeader } from '@/components/ui';
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, SUBSCRIPTION_PROVIDERS } from '@/server/ai';
import { chatGptAccount } from '@/server/ai/chatgpt-auth';
import { claudeCodeStatus } from '@/server/ai/claude-code';
import { getAppContext } from '@/server/context';

export const metadata: Metadata = { title: 'AI provider' };

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage({ searchParams }: PageProps<'/settings/ai'>) {
  const { ai, settings } = getAppContext();
  const { error } = await searchParams;
  const current = settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS);
  const status = ai.status();
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="AI provider" subtitle="Job Scraper uses your own AI account: an API key (kept only in your .env file, never shown or stored in the database), your ChatGPT plan, or your own Claude Code." />
      {typeof error === 'string' && <p role="alert" className="rounded border border-red-400 px-3 py-2 text-sm">{error.slice(0, 300)}</p>}
      <Card title="Status">
        <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm">
          <dt className="text-neutral-500">State</dt>
          <dd data-testid="ai-state">
            {status.configured ? (
              <Badge tone="green">Ready</Badge>
            ) : status.provider === 'none' ? (
              <>
                <Badge>Offline (no AI)</Badge> Rule-based extraction and matching. Choose a provider below to use AI.
              </>
            ) : (
              <>
                <Badge tone="amber">Not configured</Badge> {status.reason}
              </>
            )}
          </dd>
          {status.keyEnvVar && (
            <>
              <dt className="text-neutral-500">API key ({status.keyEnvVar})</dt>
              <dd>{status.keyPresent ? 'Set in .env' : 'Not set'}</dd>
            </>
          )}
          <dt className="text-neutral-500">Models</dt>
          <dd>{status.models.fast ? `fast: ${status.models.fast} · quality: ${status.models.quality}` : '—'}</dd>
          <dt className="text-neutral-500">Spent today (estimate)</dt>
          <dd>{SUBSCRIPTION_PROVIDERS.includes(status.provider) ? 'Paid through your plan' : `$${status.spentTodayUsd.toFixed(3)}${status.dailyBudgetUsd !== null ? ` of $${status.dailyBudgetUsd.toFixed(2)}` : ''}`}</dd>
        </dl>
      </Card>
      <Card title="Configuration">
        <AiSettingsForm initial={current} chatgpt={chatGptAccount(settings)} claudeCode={process.env.JOB_SCRAPER_IN_DOCKER === 'true' ? null : await claudeCodeStatus()} />
      </Card>
      <Card title="What leaves your machine">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          When AI is enabled, the text of your CV and of job descriptions is sent to the provider you choose, so it can extract, match and tailor. With ChatGPT it goes to OpenAI under your ChatGPT plan; with Claude Code, to Anthropic through your own Claude Code. With Ollama, everything stays on your computer. With “None”, Job Scraper works offline with simpler, rule-based extraction and matching.
        </p>
      </Card>
    </div>
  );
}
