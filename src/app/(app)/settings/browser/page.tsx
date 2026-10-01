import type { Metadata } from 'next';
import { BrowserSettingsForm, SignInForm } from '@/components/settings/browser-forms';
import { Card, Notice, PageHeader } from '@/components/ui';
import { BROWSER_SETTINGS_KEY, BrowserSettingsSchema, DEFAULT_BROWSER_SETTINGS } from '@/server/applications/browser-apply';
import { getAppContext } from '@/server/context';

export const metadata: Metadata = { title: 'Browser settings' };

export const dynamic = 'force-dynamic';

export default function BrowserSettingsPage() {
  const s = getAppContext().settings.get(BROWSER_SETTINGS_KEY, BrowserSettingsSchema, DEFAULT_BROWSER_SETTINGS);
  const forcedHeadless = process.env.JOB_SCRAPER_BROWSER_HEADLESS === 'true';
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Browser" subtitle="How Job Scraper applies on job websites. It fills in what your profile answers truthfully, uploads your tailored CV and submits; anything it can’t do (CAPTCHA, verification codes, sign-in, unanswerable questions) is skipped with the reason." />
      {forcedHeadless && <Notice tone="amber">This installation runs the browser without a window (JOB_SCRAPER_BROWSER_HEADLESS=true, e.g. in Docker). Screenshots in each application show what happened.</Notice>}
      <Card title="Applying">
        <BrowserSettingsForm visible={s.visible} dailyCap={s.dailyCap} />
      </Card>
      <Card title="Sign in to a site">
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">Some job sites need an account. Sign in once in Job Scraper’s browser; the session is kept on this computer (in the data folder) and used for applications on that site. Job Scraper never types your passwords, and sites may still ask for verification, in which case the application is skipped.</p>
        <SignInForm />
      </Card>
    </div>
  );
}
