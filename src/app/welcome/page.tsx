import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/ui';
import { AiStep } from '@/components/welcome/ai-step';
import { CvStep } from '@/components/welcome/cv-step';
import { PreferencesStep } from '@/components/welcome/preferences-step';
import { Progress, STEP_ORDER, type WizardStep } from '@/components/welcome/progress';
import { ReviewStep } from '@/components/welcome/review-step';
import { StartStep } from '@/components/welcome/start-step';
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, KEY_ENV_VAR } from '@/server/ai/settings';
import { chatGptAccount } from '@/server/ai/chatgpt-auth';
import { claudeCodeStatus } from '@/server/ai/claude-code';
import { liveEnv } from '@/server/config/env-store';
import { getAppContext } from '@/server/context';
import { onboardingStatus } from '@/server/onboarding';
import { suggestedPreferences } from '@/server/onboarding-steps';
import { formatExpectedSalary, missingFields } from '@/server/profile/model';

export const metadata: Metadata = { title: 'Set up Job Scraper' };

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
  const ai = ctx.ai.status();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm font-medium text-neutral-500">Job Scraper</p>
        <h1 className="text-2xl font-semibold">Let’s set up your job search</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing is searched until you finish. Your data stays on this computer, except what you send to the AI provider you choose.</p>
      </header>
      <Progress current={step} reached={current} />
      {step === 'ai' && (
        <AiStep
          initial={ctx.settings.get(AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS)}
          savedKeys={Object.fromEntries(Object.entries(KEY_ENV_VAR).map(([p, v]) => [p, !!liveEnv()[v]]))}
          inDocker={inDocker}
          connected={status.state.aiVerifiedAt !== null && ai.configured ? `${ai.provider} · ${ai.models.fast} / ${ai.models.quality}` : null}
          chatgpt={chatGptAccount(ctx.settings)}
          claudeCode={inDocker ? null : await claudeCodeStatus()}
          error={typeof params.error === 'string' ? params.error.slice(0, 300) : null}
          justSignedIn={params.chatgpt === 'connected'}
        />
      )}
      {step === 'cv' && (
        <CvStep
          cv={status.cv && { name: status.cv.originalName, status: status.cv.status, error: status.cv.error }}
          model={ai.models.fast}
          replacing={current !== 'cv'}
        />
      )}
      {step === 'review' && status.profile && (
        <ReviewStep
          profileId={status.profile.id}
          data={status.profile.data}
          missing={missingFields(status.profile.data).filter((f) => f !== 'application.expectedSalary' && f !== 'application.noticePeriod').length}
          readWithoutAi={status.cv?.extractionMethod === 'heuristic'}
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
