import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/ui';
import { AiStep } from '@/components/welcome/ai-step';
import { CvStep } from '@/components/welcome/cv-step';
import { PreferencesStep } from '@/components/welcome/preferences-step';
import { Progress, STEP_ORDER, type WizardStep } from '@/components/welcome/progress';
import { ReviewStep } from '@/components/welcome/review-step';
import { StartStep } from '@/components/welcome/start-step';
import { z } from 'zod';
import { AI_PROVIDERS, AI_SETTINGS_KEY, AI_TASKS, KEY_ENV_VAR, migrateAiSettings, PROVIDER_LABELS, type AiProvider, type AiTask } from '@/server/ai/settings';
import { chatGptAccount } from '@/server/ai/chatgpt-auth';
import { claudeCodeStatus } from '@/server/ai/claude-code';
import { listModels, type ModelList } from '@/server/ai/models';
import { aiStateLine } from '@/server/ai/provider-view';
import { seedTasks } from '@/server/ai/seed';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { onboardingStatus } from '@/server/onboarding';
import { cvWaitNotice, suggestedPreferences } from '@/server/onboarding-steps';
import { getSystemStatus } from '@/server/status';
import { plural } from '@/lib/format';
import { formatExpectedSalary, missingFields, type ProfileData } from '@/server/profile/model';

export const metadata: Metadata = { title: 'Set up Job Scraper' };

/** "3 jobs · 14 skills · 1 education entry": what the AI found in the CV. */
const foundIn = (d: ProfileData) =>
  [plural(d.experience.length, 'job'), plural(d.skills.length, 'skill'), plural(d.education.length, 'education entry', 'education entries')].join(' · ');

export const dynamic = 'force-dynamic';

/** Onboarding (PRD §7, §9, §59): one step at a time. An earlier step can be opened again with ?step=. */
export default async function WelcomePage({ searchParams }: PageProps<'/welcome'>) {
  const ctx = getAppContext();
  const status = onboardingStatus(ctx);
  if (status.step === 'done') redirect('/');
  const current = status.step as WizardStep;
  const params = await searchParams;
  const asked = params.step;
  const inDocker = process.env.JOB_SCRAPER_IN_DOCKER === 'true';
  const step = typeof asked === 'string' && (STEP_ORDER as readonly string[]).includes(asked) && STEP_ORDER.indexOf(asked as WizardStep) < STEP_ORDER.indexOf(current) ? (asked as WizardStep) : current;
  const reading = ctx.ai.taskStatus('cv-extract');
  const system = getSystemStatus(ctx);
  const waitNotice = cvWaitNotice({ workerOnline: system.worker.online, cv: step === 'cv' ? status.cv : null, now: new Date(system.generatedAt) });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm font-medium text-neutral-500">Job Scraper</p>
        <h1 className="text-2xl font-semibold">Let’s set up your job search</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing is searched until you finish. Your data stays on this computer, except what you send to the AI provider you choose.</p>
      </header>
      <Progress current={step} reached={current} />
      {waitNotice && (
        <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-sm" data-testid="wizard-wait-notice">
          {waitNotice}
        </p>
      )}
      {step === 'ai' && (
        <AiStep
          {...(await aiStepProps(ctx, status.state.aiVerifiedAt !== null, inDocker))}
          error={typeof params.error === 'string' ? params.error.slice(0, 300) : null}
        />
      )}
      {step === 'cv' && (
        <CvStep
          cv={status.cv && { name: status.cv.originalName, sizeBytes: status.cv.sizeBytes, status: status.cv.status, error: status.cv.error, uploadedAt: status.cv.uploadedAt.getTime() }}
          model={reading.model}
          found={status.cv?.status === 'applied' && status.profile ? foundIn(status.profile.data) : null}
        />
      )}
      {step === 'review' && status.profile && (
        <ReviewStep
          profileId={status.profile.id}
          data={status.profile.data}
          missing={missingFields(status.profile.data).filter((f) => f !== 'application.expectedSalary' && f !== 'application.noticePeriod').length}
          readWithoutAi={status.cv?.extractionMethod === 'heuristic'}
          cvName={status.cv?.originalName ?? null}
        />
      )}
      {step === 'preferences' && status.profile && <PreferencesStep initial={suggestedPreferences(status.profile)} />}
      {step === 'start' && status.profile && (
        <StartStep
          titles={status.profile.preferences.targetTitles}
          places={status.profile.preferences.locations}
          remote={status.profile.preferences.remoteScope}
          salary={formatExpectedSalary(status.profile.preferences)}
          sources={ctx.sources.list().filter((s) => s.enabled).map((s) => s.name)}
          interval={ctx.scheduler.getState().intervalMinutes}
        />
      )}
      {(step === 'review' || step === 'preferences' || step === 'start') && !status.profile && <Notice tone="amber">Your profile is missing. Upload your CV again.</Notice>}
    </div>
  );
}

/** Everything the AI step shows, worked out from what is saved and what is ready on this computer. */
async function aiStepProps(ctx: ReturnType<typeof getAppContext>, verified: boolean, inDocker: boolean) {
  const { ai, settings } = ctx;
  const env = liveEnv();
  const current = migrateAiSettings(settings.get(AI_SETTINGS_KEY, z.unknown(), undefined), env);
  const claudeCode = inDocker ? null : await claudeCodeStatus();
  const chatgpt = chatGptAccount(settings);
  const ready = (['google', 'openai', 'anthropic', 'chatgpt', 'claude-code'] as const).filter((p) => (p === 'claude-code' ? !!claudeCode?.loggedIn : ai.providerStatus(p).configured));
  const statuses = AI_PROVIDERS.map((p) => ai.providerStatus(p));
  // listModels never throws and falls back to the built-in list (and doesn't call out without a key or address).
  const lists = Object.fromEntries(await Promise.all(statuses.map(async (s) => [s.provider, await listModels(s.provider, { env, baseUrl: s.baseUrl })] as const))) as Record<AiProvider, ModelList>;
  const taskStatuses = AI_TASKS.map((t) => ai.taskStatus(t));
  return {
    tasks: seedTasks(current.tasks, ready),
    models: Object.fromEntries(AI_PROVIDERS.map((p) => [p, lists[p].models])) as Record<AiProvider, string[]>,
    notes: Object.fromEntries(taskStatuses.filter((t) => t.provider !== 'none' && !t.configured && t.reason).map((t) => [t.task, t.reason])) as Partial<Record<AiTask, string>>,
    keys: (['google', 'openai', 'anthropic'] as const).map((p) => ({ label: PROVIDER_LABELS[p], envVar: KEY_ENV_VAR[p]!, present: statuses.find((s) => s.provider === p)!.keyPresent })),
    addresses: { ollama: current.providers.ollama?.baseUrl ?? '', 'openai-compatible': current.providers['openai-compatible']?.baseUrl ?? '' },
    inDocker,
    stateLine: verified ? aiStateLine(taskStatuses, new Set()) : null,
    chatgpt,
    claudeCode,
  };
}
