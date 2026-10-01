/**
 * What the System page shows (PRD §52): how discovery, applications, notifications, email, the queue and AI have
 * been doing over the last days, with the latest errors, so a failure is visible without reading logs.
 */
import { and, count, desc, eq, gte, inArray, ne, not, or, sql, sum } from 'drizzle-orm';
import type { Db } from '../db';
import { aiUsage, applications, notifications, queueTasks, sentEmails, sourceRuns, sources } from '../db/schema';

const DAY_MS = 86_400_000;
/**
 * Not failures of background work: a link the user added that couldn't be read is answered on the Jobs page, and
 * work cancelled on purpose (Stop, a deleted application) didn't go wrong.
 */
const NOT_A_FAILURE = or(eq(queueTasks.type, 'discovery.url'), sql`coalesce(${queueTasks.lastError}, '') = 'Cancelled'`);
const FAILED_STATUSES = ['PREPARATION_FAILED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED'] as const;

export interface SystemReport {
  days: number;
  sources: Array<{
    id: number;
    name: string;
    enabled: boolean;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    week: { runs: number; failed: number; found: number; newJobs: number };
  }>;
  discovery: { runs: number; failedRuns: number; found: number; newJobs: number; updated: number; expired: number; parseErrors: number };
  applications: { created: number; failures: Array<{ code: string; method: string; count: number }> };
  notifications: Array<{ channel: string; sent: number; failed: number; pending: number; lastError: string | null }>;
  emails: { sent: number; failed: number; uncertain: number; sending: number; lastError: string | null };
  queue: { counts: Record<'pending' | 'running' | 'done' | 'failed', number>; failed: Array<{ id: number; type: string; attempts: number; lastError: string | null; updatedAt: Date }> };
  ai: { todayUsd: number; weekUsd: number; failedCalls: number; byTask: Array<{ task: string; calls: number; usd: number }> };
}

const n = (v: unknown) => Number(v ?? 0);

export function systemReport(db: Db, opts: { now?: Date; days?: number } = {}): SystemReport {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const since = new Date(now.getTime() - days * DAY_MS);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const runsBySource = db
    .select({ sourceId: sourceRuns.sourceId, runs: count(), failed: sum(sql`${sourceRuns.status} = 'failed'`), found: sum(sourceRuns.found), newJobs: sum(sourceRuns.newJobs), updated: sum(sourceRuns.updated), expired: sum(sourceRuns.expired), parseErrors: sum(sourceRuns.parseErrors) })
    .from(sourceRuns)
    .where(gte(sourceRuns.startedAt, since))
    .groupBy(sourceRuns.sourceId)
    .all();
  const sourceList = db
    .select()
    .from(sources)
    // "Added by you" holds pasted jobs; it is never scanned, so it has nothing to report.
    .where(ne(sources.adapterId, 'manual'))
    .all()
    .map((s) => {
      const r = runsBySource.find((x) => x.sourceId === s.id);
      return { id: s.id, name: s.name, enabled: s.enabled, lastRunAt: s.lastRunAt, lastStatus: s.lastStatus, lastError: s.lastError, consecutiveFailures: s.consecutiveFailures, week: { runs: n(r?.runs), failed: n(r?.failed), found: n(r?.found), newJobs: n(r?.newJobs) } };
    })
    // Failing sources first, then by name.
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.name.localeCompare(b.name));
  const total = (k: 'runs' | 'failed' | 'found' | 'newJobs' | 'updated' | 'expired' | 'parseErrors') => runsBySource.reduce((acc, r) => acc + n(r[k]), 0);

  const created = n(db.select({ n: count() }).from(applications).where(gte(applications.createdAt, since)).get()?.n);
  const failures = db
    .select({ code: applications.failureCode, method: applications.method, count: count() })
    .from(applications)
    .where(and(inArray(applications.status, [...FAILED_STATUSES]), gte(applications.updatedAt, since)))
    .groupBy(applications.failureCode, applications.method)
    .all()
    .map((f) => ({ code: f.code ?? 'UNKNOWN', method: f.method, count: n(f.count) }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const notifRows = db
    .select({ channel: notifications.channel, status: notifications.status, count: count() })
    .from(notifications)
    .where(gte(notifications.createdAt, since))
    .groupBy(notifications.channel, notifications.status)
    .all();
  const notif = [...new Set(notifRows.map((r) => r.channel))].sort().map((channel) => {
    const of = (status: string) => n(notifRows.find((r) => r.channel === channel && r.status === status)?.count);
    const lastError = db.select({ error: notifications.error }).from(notifications).where(and(eq(notifications.channel, channel), eq(notifications.status, 'failed'), gte(notifications.createdAt, since))).orderBy(desc(notifications.createdAt)).limit(1).get()?.error ?? null;
    return { channel, sent: of('sent'), failed: of('failed'), pending: of('pending'), lastError };
  });

  const emailRows = db.select({ status: sentEmails.status, count: count() }).from(sentEmails).where(gte(sentEmails.createdAt, since)).groupBy(sentEmails.status).all();
  const emailOf = (status: string) => n(emailRows.find((r) => r.status === status)?.count);
  const emailError = db.select({ error: sentEmails.error }).from(sentEmails).where(and(inArray(sentEmails.status, ['failed', 'uncertain']), gte(sentEmails.createdAt, since))).orderBy(desc(sentEmails.createdAt)).limit(1).get()?.error ?? null;

  const queueRows = db.select({ status: queueTasks.status, count: count() }).from(queueTasks).where(not(and(eq(queueTasks.status, 'failed'), NOT_A_FAILURE)!)).groupBy(queueTasks.status).all();
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of queueRows) counts[r.status] = n(r.count);
  const failedTasks = db
    .select({ id: queueTasks.id, type: queueTasks.type, attempts: queueTasks.attempts, lastError: queueTasks.lastError, updatedAt: queueTasks.updatedAt })
    .from(queueTasks)
    .where(and(eq(queueTasks.status, 'failed'), not(NOT_A_FAILURE!)))
    .orderBy(desc(queueTasks.updatedAt))
    .limit(10)
    .all();

  const spend = (from: Date) => n(db.select({ usd: sum(aiUsage.costUsd) }).from(aiUsage).where(gte(aiUsage.createdAt, from)).get()?.usd);
  const byTask = db
    .select({ task: aiUsage.task, calls: count(), usd: sum(aiUsage.costUsd) })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, since))
    .groupBy(aiUsage.task)
    .all()
    .map((r) => ({ task: r.task, calls: n(r.calls), usd: n(r.usd) }))
    .sort((a, b) => b.usd - a.usd);

  return {
    days,
    sources: sourceList,
    discovery: { runs: total('runs'), failedRuns: total('failed'), found: total('found'), newJobs: total('newJobs'), updated: total('updated'), expired: total('expired'), parseErrors: total('parseErrors') },
    applications: { created, failures },
    notifications: notif,
    emails: { sent: emailOf('sent'), failed: emailOf('failed'), uncertain: emailOf('uncertain'), sending: emailOf('sending'), lastError: emailError },
    queue: { counts, failed: failedTasks },
    ai: { todayUsd: spend(midnight), weekUsd: spend(since), failedCalls: n(db.select({ n: count() }).from(aiUsage).where(and(eq(aiUsage.ok, false), gte(aiUsage.createdAt, since))).get()?.n), byTask },
  };
}
