import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { Badge, Card, Notice, PageHeader } from '@/components/ui';
import { formatWhen, plural } from '@/lib/format';
import { AI_PROVIDERS, AI_TASKS, PROVIDER_LABELS, SUBSCRIPTION_PROVIDERS, TASK_LABELS } from '@/server/ai';
import { usageLabel } from '@/server/ai/privacy';
import { getAppContext } from '@/server/context';
import { createFailureLog, describeFailure } from '@/server/failures';
import { describeInterval } from '@/server/scheduler';
import { getSystemStatus } from '@/server/status';
import { readScraplingStatus } from '@/server/scrapling/status';
import { systemReport } from '@/server/status/report';
import { versionInfo } from '@/server/status/version';

export const metadata: Metadata = { title: 'System' };

export const dynamic = 'force-dynamic';

const CHANNEL_NAMES: Record<string, string> = { inapp: 'In-app', browser: 'Browser', desktop: 'Desktop', email: 'Email', telegram: 'Telegram' };

const usd = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
const th = 'py-1 pr-4 text-left font-medium text-neutral-500';
const td = 'py-1 pr-4 align-top';

/** PRD §52: everything Job Scraper did lately, and what went wrong, without reading logs. */
export default function SystemPage() {
  const ctx = getAppContext();
  const s = getSystemStatus(ctx);
  const now = s.generatedAt;
  const r = systemReport(ctx.db, { now: new Date(now) });
  const taskRoutes = AI_TASKS.map((t) => ctx.ai.taskStatus(t));
  const providersInUse = AI_PROVIDERS.filter((p) => p !== 'none' && taskRoutes.some((t) => t.provider === p)).map((p) => ctx.ai.providerStatus(p));
  const failingSources = r.sources.filter((x) => x.enabled && x.consecutiveFailures > 0);
  const problems = createFailureLog(ctx.settings).recent().filter((p) => now - p.at < r.days * 86_400_000);
  const v = versionInfo();
  const reader = readScraplingStatus(ctx.settings);
  return (
    <div className="max-w-5xl space-y-6">
      <AutoRefresh everyMs={30_000} />
      <PageHeader title="System" subtitle={`What Job Scraper has been doing over the last ${r.days} days, and anything that went wrong.`} />
      {!s.worker.online && <Notice tone="red">The worker is not running, so nothing is scanned, prepared or sent. Start Job Scraper with <code>pnpm start</code>.</Notice>}
      {reader && !reader.ready && (
        <Notice tone="red">
          <span data-testid="system-scrapling-missing">Web discovery and Add by link can’t read job pages: {reader.error} Job boards still work. Run <code>pnpm run setup</code>, then restart Job Scraper.</span>
        </Notice>
      )}

      <Card title="Overview">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4" data-testid="system-overview">
          <div><dt className="text-neutral-500">Worker</dt><dd>{s.worker.online ? 'Online' : 'Offline'}{s.worker.lastSeenAt ? ` · seen ${formatWhen(s.worker.lastSeenAt, now)}` : ''}</dd></div>
          <div><dt className="text-neutral-500">Job discovery</dt><dd>{s.scheduler.enabled ? describeInterval(s.scheduler.intervalMinutes) : 'Paused'}</dd></div>
          <div><dt className="text-neutral-500">Last scan</dt><dd>{s.lastScan ? `${s.lastScan.status} · ${formatWhen(s.lastScan.startedAt, now)}` : 'Never'}</dd></div>
          <div><dt className="text-neutral-500">AI spend today</dt><dd>{usd(r.ai.todayUsd)}</dd></div>
          <div data-testid="system-page-reader"><dt className="text-neutral-500">Page reader</dt><dd>{!reader ? 'Not checked yet' : reader.ready ? `Scrapling ${reader.scrapling} · Python ${reader.python} · ready` : 'Not installed'}</dd></div>
        </dl>
      </Card>

      <Card title="Recent problems">
        {problems.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="system-problems">Nothing went wrong in discovery or matching this week.</p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="system-problems">
            {problems.slice(0, 15).map((p, i) => {
              const d = describeFailure(p.code);
              return (
                <li key={`${p.at}-${i}`}>
                  <b>{d.title}</b> <span className="text-neutral-500">({p.code}) · {formatWhen(p.at, now)}{p.context ? ` · ${p.context}` : ''}</span>
                  <span className="block">{p.message}</span>
                  <span className="block text-xs text-neutral-500">{d.help}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Job sources">
        <p className="mb-3 text-sm" data-testid="system-discovery">
          This week: {plural(r.discovery.runs, 'source scan')}{r.discovery.failedRuns ? ` (${r.discovery.failedRuns} failed)` : ''}, {plural(r.discovery.found, 'listing')} seen, {plural(r.discovery.newJobs, 'new job')}, {r.discovery.updated} updated, {r.discovery.expired} expired
          {r.discovery.parseErrors ? `, ${plural(r.discovery.parseErrors, 'listing')} that couldn’t be read` : ''}.
        </p>
        {failingSources.length > 0 && <Notice tone="amber">{failingSources.length === 1 ? '1 source keeps' : `${failingSources.length} sources keep`} failing. Check them on the <Link href="/sources" className="underline">Job sources</Link> page.</Notice>}
        {r.sources.length === 0 ? (
          <p className="text-sm text-neutral-500">No sources yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>Source</th><th className={th}>Last run</th><th className={th}>This week</th><th className={th}>Problem</th></tr></thead>
              <tbody>
                {r.sources.map((x) => (
                  <tr key={x.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className={td}>{x.name}{!x.enabled && <> <Badge>off</Badge></>}</td>
                    <td className={td}>{x.lastRunAt ? `${x.lastStatus ?? ''} · ${formatWhen(x.lastRunAt, now)}` : 'Never'}</td>
                    <td className={td}>{plural(x.week.runs, 'run')} · {x.week.found} seen · {x.week.newJobs} new{x.week.failed ? ` · ${x.week.failed} failed` : ''}</td>
                    <td className={td}>{x.consecutiveFailures ? <span className="text-red-700 dark:text-red-400">{plural(x.consecutiveFailures, 'failure')} in a row{x.lastError ? `: ${x.lastError}` : ''}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Applications">
        <p className="mb-3 text-sm">This week: {plural(r.applications.created, 'application')} prepared.</p>
        {r.applications.failures.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="system-failures">No failed or skipped applications this week.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="system-failures">
            {r.applications.failures.map((f) => (
              <li key={`${f.code}-${f.method}`}>
                <Link href="/applications?tab=failed" className="underline">{describeFailure(f.code).title}</Link> <span className="text-neutral-500">({f.code}, {f.method === 'manual' ? 'preparation' : f.method})</span>: {f.count}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Delivery">
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h3 className="mb-2 font-medium">Notifications</h3>
            {r.notifications.length === 0 ? (
              <p className="text-neutral-500">None sent this week.</p>
            ) : (
              <ul className="space-y-1" data-testid="system-notifications">
                {r.notifications.map((c) => (
                  <li key={c.channel}>
                    {CHANNEL_NAMES[c.channel] ?? c.channel}: {c.sent} sent{c.failed ? `, ${c.failed} failed` : ''}{c.pending ? `, ${c.pending} waiting` : ''}
                    {c.lastError && <span className="block text-xs text-red-700 dark:text-red-400">Last error: {c.lastError}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 font-medium">Application emails</h3>
            <p data-testid="system-emails">
              {r.emails.sent} sent, {r.emails.failed} failed{r.emails.uncertain ? `, ${r.emails.uncertain} waiting for you to check` : ''}{r.emails.sending ? `, ${r.emails.sending} sending` : ''}.
            </p>
            {r.emails.lastError && <p className="text-xs text-red-700 dark:text-red-400">Last error: {r.emails.lastError}</p>}
          </div>
        </div>
      </Card>

      <Card title="Background work">
        <p className="mb-3 text-sm" data-testid="system-queue">
          {r.queue.counts.pending} waiting · {r.queue.counts.running} running · {r.queue.counts.failed} failed
        </p>
        {r.queue.failed.length > 0 && (
          <ul className="space-y-1 text-sm">
            {r.queue.failed.map((t) => (
              <li key={t.id}>
                <code>{t.type}</code> · {formatWhen(t.updatedAt, now)} · gave up after {plural(t.attempts, 'attempt')}{t.lastError ? `: ${t.lastError}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="AI usage">
        <p className="mb-3 text-sm" data-testid="system-ai">
          Today {usd(r.ai.todayUsd)} · this week {usd(r.ai.weekUsd)}{r.ai.failedCalls ? ` · ${plural(r.ai.failedCalls, 'failed call')}` : ''}. Change providers and limits: <Link href="/settings/ai" className="underline">AI provider</Link>.
        </p>
        <table className="text-sm" data-testid="system-ai-routes">
          <thead><tr><th className={th}>Task</th><th className={th}>Runs on</th></tr></thead>
          <tbody>
            {taskRoutes.map((t) => (
              <tr key={t.task} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className={td}>{TASK_LABELS[t.task].title}</td>
                <td className={td}>
                  {t.provider === 'none' ? (
                    <span className="text-neutral-500">Offline on purpose (None). {TASK_LABELS[t.task].hint}</span>
                  ) : (
                    <>
                      {PROVIDER_LABELS[t.provider]} · {t.model ?? 'no model chosen'}
                      {!t.configured && <> <Badge tone="amber">Not ready</Badge> <span className="text-neutral-500">{t.reason}</span></>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {providersInUse.length > 0 && (
          <table className="mt-4 text-sm" data-testid="system-ai-providers">
            <thead><tr><th className={th}>Provider</th><th className={th}>Today</th><th className={th}>Daily limit</th></tr></thead>
            <tbody>
              {providersInUse.map((p) => {
                const plan = SUBSCRIPTION_PROVIDERS.includes(p.provider);
                return (
                  <tr key={p.provider} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className={td}>{PROVIDER_LABELS[p.provider]}</td>
                    <td className={td}>{plan ? plural(p.callsToday, 'call') : `${plural(p.callsToday, 'call')} · ${usd(p.spentTodayUsd)}`}</td>
                    <td className={td}>{plan ? (p.dailyCallLimit === null ? 'none' : plural(p.dailyCallLimit, 'call')) : p.dailyBudgetUsd === null ? 'none' : usd(p.dailyBudgetUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {r.ai.byTask.length > 0 && (
          <>
            <h3 className="mb-1 mt-4 text-sm font-medium text-neutral-500">Last {r.days} days</h3>
            <table className="text-sm" data-testid="system-ai-usage">
              <thead><tr><th className={th}>What</th><th className={th}>Calls</th><th className={th}>Failed</th><th className={th}>Cost</th></tr></thead>
              <tbody>
                {r.ai.byTask.map((x) => (
                  <tr key={x.task} className="border-t border-neutral-200 dark:border-neutral-800"><td className={td}>{usageLabel(x.task)}</td><td className={td}>{x.calls}</td><td className={td}>{x.failed}</td><td className={td}>{usd(x.usd)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-neutral-500">Calls through a ChatGPT or Claude plan cost $0 here; they count against the daily call limit instead.</p>
          </>
        )}
      </Card>

      <Card title="Version">
        <p className="text-sm" data-testid="system-version">
          Job Scraper {v.version}. <a href={v.releasesUrl} target="_blank" rel="noreferrer" className="underline">See the latest release</a> · <a href={v.updateGuideUrl} target="_blank" rel="noreferrer" className="underline">How to update</a>
        </p>
      </Card>
    </div>
  );
}
