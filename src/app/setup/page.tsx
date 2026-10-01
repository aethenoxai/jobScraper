import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, btnPrimary, Card, PageHeader } from '@/components/ui';
import { getAppContext } from '@/server/context';
import { onboardingSteps } from '@/server/onboarding';

export const metadata: Metadata = { title: 'Get started' };

export const dynamic = 'force-dynamic';

/** First run (PRD §59): from install to a running job search, one step at a time. */
export default function SetupPage() {
  const { steps, complete, next } = onboardingSteps(getAppContext());
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Get started"
        subtitle="Six steps from a fresh install to Job Scraper looking for jobs on its own. Each one opens the page where you do it; this list updates as you go."
      />
      {complete ? (
        <Card>
          <p className="text-sm" data-testid="setup-complete">
            You’re all set. New matching jobs appear in the <Link href="/feed" className="underline">job feed</Link>, and you’ll be told about them the way you chose.
          </p>
        </Card>
      ) : (
        next && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                Next: <b>{next.title}</b>
              </p>
              <Link href={next.href} className={btnPrimary} data-testid="setup-next">
                Go to this step
              </Link>
            </div>
          </Card>
        )
      )}
      <ol className="space-y-3" data-testid="setup-steps">
        {steps.map((s, i) => (
          <li key={s.id} data-step={s.id} data-done={s.done} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-green-600 text-white' : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'}`}>
              {s.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={s.href} className="font-medium underline">{s.title}</Link>
                {s.done ? <Badge tone="green">Done</Badge> : <Badge>To do</Badge>}
              </div>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-neutral-500">Job Scraper never applies anywhere on its own: every application waits for your approval.</p>
    </div>
  );
}
