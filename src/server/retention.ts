/**
 * Keeps the local database from growing forever (PLAN M9): old history that nobody needs is removed daily.
 * Nothing an application still relies on is touched (documents, timeline events, sent emails, the application).
 */
import { and, eq, inArray, isNotNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { readdirSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from './db';
import { aiUsage, applications, inboxMessages, jobAnalyses, jobListings, jobs, notifications, profiles, queueTasks, scanRuns } from './db/schema';
import type { SettingsStore } from './settings';
import { StoragePaths, type FileStore } from './storage';

const DAY = 86_400_000;
export const RETENTION = {
  readNotificationsDays: 90,
  doneTasksDays: 30,
  failedTasksDays: 90,
  scanHistoryDays: 90,
  closedEmailTextDays: 180,
  /** Jobs no longer listed keep their row (so they are never announced as new again, N5) but lose their text. */
  closedJobTextDays: 90,
  unusedAnalysesDays: 90,
  aiUsageDays: 90,
} as const;

const MAINTAINED_KEY = 'db.maintainedAt';
const MAINTENANCE_EVERY_MS = 7 * DAY;

/**
 * Whether the weekly VACUUM is due, counted across restarts (a worker rarely stays up for a week). The first check
 * only starts the clock (no VACUUM while the app is starting for the first time).
 */
export function maintenanceDue(settings: SettingsStore, now: Date = new Date()): boolean {
  const last = settings.get(MAINTAINED_KEY, z.number().nullable(), null);
  if (last === null) settings.set(MAINTAINED_KEY, now.getTime());
  return last !== null && now.getTime() - last >= MAINTENANCE_EVERY_MS;
}

/** Records a finished VACUUM (a failed one is tried again at the next daily check). */
export function maintenanceDone(settings: SettingsStore, now: Date = new Date()): void {
  settings.set(MAINTAINED_KEY, now.getTime());
}

export function pruneOldData(db: Db, now: Date = new Date()): { notifications: number; tasks: number; scans: number; snippets: number; descriptions: number; analyses: number; aiUsage: number } {
  const before = (days: number) => new Date(now.getTime() - days * DAY);
  return db.transaction((tx) => {
    // Read inbox items and delivered/failed external sends; unread items stay until read.
    const n = tx
      .delete(notifications)
      .where(
        and(
          lt(notifications.createdAt, before(RETENTION.readNotificationsDays)),
          // In-app rows count as "sent" once stored, so for them only reading them makes them removable.
          or(and(eq(notifications.channel, 'inapp'), isNotNull(notifications.readAt)), and(ne(notifications.channel, 'inapp'), inArray(notifications.status, ['sent', 'failed']))),
        ),
      )
      .run().changes;
    const tasks =
      tx.delete(queueTasks).where(and(eq(queueTasks.status, 'done'), lt(queueTasks.updatedAt, before(RETENTION.doneTasksDays)))).run().changes +
      tx.delete(queueTasks).where(and(eq(queueTasks.status, 'failed'), lt(queueTasks.updatedAt, before(RETENTION.failedTasksDays)))).run().changes;
    // Scan history (source runs go with their scan); the latest 20 scans always stay.
    const keep = tx.select({ id: scanRuns.id }).from(scanRuns).orderBy(sql`${scanRuns.id} desc`).limit(20).all().map((r) => r.id);
    const scans = tx
      .delete(scanRuns)
      .where(and(lt(scanRuns.startedAt, before(RETENTION.scanHistoryDays)), keep.length ? notInArray(scanRuns.id, keep) : undefined))
      .run().changes;
    // Email text of applications closed long ago; who wrote and when stays in the timeline.
    const closed = tx
      .select({ id: applications.id })
      .from(applications)
      .where(and(inArray(applications.status, ['REJECTED', 'WITHDRAWN', 'EXPIRED']), lt(applications.updatedAt, before(RETENTION.closedEmailTextDays))))
      .all()
      .map((r) => r.id);
    const snippets = closed.length ? tx.update(inboxMessages).set({ snippet: null }).where(and(inArray(inboxMessages.applicationId, closed), isNotNull(inboxMessages.snippet))).run().changes : 0;
    // Text of jobs gone for months that nobody applied to. The hash changes too, so if the posting comes back its
    // text counts as new and is stored again.
    const descriptions = tx
      .update(jobListings)
      .set({ description: '', descriptionHash: sql`'pruned:' || ${jobListings.id}` })
      .where(
        and(
          ne(jobListings.description, ''),
          inArray(
            jobListings.jobId,
            tx
              .select({ id: jobs.id })
              .from(jobs)
              .where(and(ne(jobs.status, 'active'), lt(jobs.lastSeenAt, before(RETENTION.closedJobTextDays)), notInArray(jobs.id, tx.select({ id: sql<number>`coalesce(${applications.jobId}, 0)` }).from(applications)))),
          ),
        ),
      )
      .run().changes;
    // Analyses no open job can use any more (a job is analysed from its longest listing, closed or not).
    const inUse = tx.select({ hash: jobListings.descriptionHash }).from(jobListings).innerJoin(jobs, eq(jobListings.jobId, jobs.id)).where(eq(jobs.status, 'active'));
    const analyses = tx
      .delete(jobAnalyses)
      .where(and(lt(jobAnalyses.createdAt, before(RETENTION.unusedAnalysesDays)), notInArray(jobAnalyses.descriptionHash, inUse)))
      .run().changes;
    const usage = tx.delete(aiUsage).where(lt(aiUsage.createdAt, before(RETENTION.aiUsageDays))).run().changes;
    return { notifications: n, tasks, scans, snippets, descriptions, analyses, aiUsage: usage };
  }, { behavior: 'immediate' });
}

/**
 * Removes the folders of applications and profiles that no longer exist (a crash between deleting the record and its
 * files leaves one behind). Returns how many were removed.
 */
export async function removeOrphanFiles(db: Db, files: FileStore): Promise<number> {
  const folders = (rel: string) => {
    try {
      return readdirSync(files.resolve(rel), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)).map((d) => Number(d.name));
    } catch {
      return [];
    }
  };
  // Folders first, records second: a record always exists before its folder, so a folder made meanwhile is never taken for an orphan.
  const appFolders = folders('applications');
  const profileFolders = folders('profiles');
  const appIds = new Set(db.select({ id: applications.id }).from(applications).all().map((r) => r.id));
  const profileIds = new Set(db.select({ id: profiles.id }).from(profiles).all().map((r) => r.id));
  const orphans = [...appFolders.filter((id) => !appIds.has(id)).map(StoragePaths.applicationDir), ...profileFolders.filter((id) => !profileIds.has(id)).map(StoragePaths.profileDir)];
  for (const rel of orphans) await files.remove(rel);
  return orphans.length;
}
