import { z } from 'zod';
import type { FailureLog } from '../failures';
import type { ProfileService } from '../profile/service';
import { PermanentError, type Queue } from '../queue';
import type { TaskHandler } from '../queue/runner';
import type { MatchService } from './service';

export const MATCH_TASK = 'match.evaluate';
export const RESCORE_TASK = 'match.rescore';
const BATCH = 25;

/** Queues matching for jobs in batches (for one profile, or every profile). Returns the number of tasks. */
export function enqueueMatching(queue: Queue, jobIds: number[], profileId?: number, opts: { force?: boolean; profiles?: number } = {}): number {
  // Keep each task's work bounded: fewer jobs per batch when every job is matched against several profiles.
  const batch = profileId ? BATCH : Math.max(5, Math.min(BATCH, Math.floor(50 / Math.max(1, opts.profiles ?? 1))));
  let n = 0;
  for (let i = 0; i < jobIds.length; i += batch) {
    queue.enqueue(MATCH_TASK, { jobIds: jobIds.slice(i, i + batch), ...(profileId ? { profileId } : {}), ...(opts.force ? { force: true } : {}) });
    n++;
  }
  return n;
}

const EvaluatePayload = z.object({ jobIds: z.array(z.number().int()), profileId: z.number().int().optional(), force: z.boolean().optional() });

export function createMatchEvaluateHandler(deps: { matching: MatchService; profiles: ProfileService; onSurfaced: (matchIds: number[]) => void; failures?: FailureLog }): TaskHandler {
  return async (payload, { signal, log }) => {
    const parsed = EvaluatePayload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid match.evaluate payload');
    const profiles = parsed.data.profileId ? deps.profiles.list().filter((p) => p.id === parsed.data.profileId) : deps.profiles.list();
    const surfaced: number[] = [];
    for (const jobId of parsed.data.jobIds) {
      for (const profile of profiles) {
        signal.throwIfAborted();
        try {
          const r = await deps.matching.evaluate(jobId, profile.id, { force: parsed.data.force, signal });
          if (r.newlySurfaced) surfaced.push(r.matchId);
        } catch (err) {
          if (signal.aborted) throw err; // stopped, not failed: the task is retried
          // MATCHING_FAILED for one job must not stop the batch.
          log.warn({ jobId, profileId: profile.id, error: (err as Error).message }, 'matching failed for a job');
          deps.failures?.record('MATCHING_FAILED', (err as Error).message ?? String(err), `job ${jobId} for profile “${profile.name}”`);
        }
      }
    }
    if (surfaced.length) deps.onSurfaced(surfaced);
  };
}

const RescorePayload = z.object({ profileId: z.number().int(), force: z.boolean().optional() });

/** Re-matches a profile: every active job when forced (the "Re-check all jobs" button), otherwise only stale ones. */
export function createRescoreHandler(deps: { matching: MatchService; queue: Queue }): TaskHandler {
  return async (payload) => {
    const parsed = RescorePayload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid match.rescore payload');
    const { profileId, force } = parsed.data;
    enqueueMatching(deps.queue, force ? deps.matching.activeJobIds() : deps.matching.staleJobIds(profileId), profileId, { force });
  };
}

/**
 * Queues matching for every job that is missing or stale for any profile (worker start, after scans).
 * Does nothing while matching is still queued: those tasks cover the same jobs.
 */
export function reconcileMatches(deps: { matching: MatchService; profiles: ProfileService; queue: Queue }): number {
  const busy = deps.queue.counts(MATCH_TASK);
  if (busy.pending + busy.running > 0) return 0;
  let tasks = 0;
  for (const p of deps.profiles.list()) {
    // New or changed jobs, plus offline-scored ones that AI can now judge properly.
    const ids = [...new Set([...deps.matching.staleJobIds(p.id), ...deps.matching.offlineScoredJobIds(p.id)])];
    tasks += enqueueMatching(deps.queue, ids, p.id);
  }
  return tasks;
}
