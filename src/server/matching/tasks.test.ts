import path from 'node:path';
import type { Ai, AiStatus } from '../ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue } from '../queue';
import { createFileStore } from '../storage';
import { createMatchService } from './service';
import { createFailureLog } from '../failures';
import { createSettings } from '../settings';
import { createMatchEvaluateHandler, createRescoreHandler, enqueueMatching, MATCH_TASK, reconcileMatches } from './tasks';

const log = createLogger({ level: 'silent' });
const ctx = { taskId: 1, attempt: 1, log, signal: new AbortController().signal };
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function setup() {
  const profiles = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'f')) });
  const queue = createQueue(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
  const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'S', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const ids = createIngestor({ db: t.db }).ingestRun(src, Array.from({ length: 30 }, (_, i) => ({ sourceJobId: String(i), sourceUrl: `https://x.example/${i}`, title: i % 2 ? 'Backend Engineer' : `Chef ${i}`, company: `Co${i}`, description: 'Go and PostgreSQL. Requirements\n• Go' })), { completeSnapshot: false }).changedJobIds;
  for (const name of ['A', 'B']) {
    const p = profiles.create(name);
    const data = emptyProfile();
    data.skills = ['Go', 'PostgreSQL'].map((n) => ({ id: '', name: n, category: 'technology' as const }));
    profiles.updateData(p.id, data);
    profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  }
  return { profiles, queue, matching, ids };
}

describe('matching tasks', () => {
  it('splits job ids into batches', () => {
    const { queue, ids } = setup();
    expect(enqueueMatching(queue, ids)).toBe(2);
    expect(queue.claim('w', [MATCH_TASK])?.payload).toEqual({ jobIds: ids.slice(0, 25) });
  });

  it('evaluates each job for every profile and reports newly surfaced matches', async () => {
    const { matching, profiles, ids } = setup();
    const surfaced: number[][] = [];
    await createMatchEvaluateHandler({ matching, profiles, onSurfaced: (m) => surfaced.push(m) })({ jobIds: ids }, ctx);
    const all = profiles.list().flatMap((p) => matching.feed(p.id, { pageSize: 100 }).items);
    expect(all.length).toBe(30); // 15 backend jobs × 2 profiles
    expect(surfaced.flat()).toHaveLength(30);
  });

  it('keeps going when one job cannot be evaluated, and records MATCHING_FAILED (PRD §51)', async () => {
    const { matching, profiles, ids } = setup();
    const surfaced: number[][] = [];
    const failures = createFailureLog(createSettings(t.db));
    await createMatchEvaluateHandler({ matching, profiles, onSurfaced: (m) => surfaced.push(m), failures })({ jobIds: [999_999, ids[1]] }, ctx);
    expect(surfaced.flat()).toHaveLength(2);
    expect(failures.recent()).toEqual([expect.objectContaining({ code: 'MATCHING_FAILED', context: expect.stringMatching(/job 999999/) }), expect.objectContaining({ code: 'MATCHING_FAILED' })]);
  });

  it('rescoring a profile queues every active job for it', async () => {
    const { queue, profiles, matching } = setup();
    const p = profiles.list()[0];
    await createRescoreHandler({ matching, queue })({ profileId: p.id }, ctx);
    const task = queue.claim('w', [MATCH_TASK]);
    expect(task?.payload).toMatchObject({ profileId: p.id });
  });

  it('a forced re-check queues every active job with force', async () => {
    const { queue, profiles, matching, ids } = setup();
    const p = profiles.list()[0];
    await createMatchEvaluateHandler({ matching, profiles, onSurfaced: () => {} })({ jobIds: ids }, ctx);
    await createRescoreHandler({ matching, queue })({ profileId: p.id, force: true }, ctx);
    const payloads = [queue.claim('w', [MATCH_TASK]), queue.claim('w', [MATCH_TASK])].map((x) => x?.payload as { jobIds: number[]; force?: boolean });
    expect(payloads.every((x) => x.force)).toBe(true);
    expect(payloads.flatMap((x) => x.jobIds)).toHaveLength(30);
  });

  it('jobs scored offline are re-queued for AI once it is available and the budget allows (final review I3)', async () => {
    const { queue, profiles, matching, ids } = setup();
    const handler = createMatchEvaluateHandler({ matching, profiles, onSurfaced: () => {} });
    await handler({ jobIds: ids }, ctx);
    while (queue.claim('w', [MATCH_TASK])) {
      /* drain the tasks queued by setup */
    }
    // Offline matches exist; without AI nothing is queued again.
    expect(reconcileMatches({ matching, profiles, queue })).toBe(0);
    let status = { configured: true, provider: 'openai', spentTodayUsd: 0, dailyBudgetUsd: 2 } as unknown as AiStatus;
    const ai = { status: () => status, generateObject: async () => Promise.reject(new Error('unused')) } as unknown as Ai;
    const withAi = createMatchService({ db: t.db, ai, queue, profiles, log, now: () => new Date(Date.now() + 7 * 3_600_000) });
    expect(reconcileMatches({ matching: withAi, profiles, queue })).toBeGreaterThan(0);
    const queued = (queue.claim('w', [MATCH_TASK])?.payload as { jobIds: number[] }).jobIds;
    // Only jobs that could pass (backend roles), not the chefs the title gate already ruled out.
    expect(queued.length).toBeGreaterThan(0);
    while (queue.claim('w', [MATCH_TASK])) {
      /* drain */
    }
    // Budget used up: wait for tomorrow.
    status = { ...status, spentTodayUsd: 2 } as AiStatus;
    expect(reconcileMatches({ matching: withAi, profiles, queue })).toBe(0);
  });

  it('editing contact details doesn’t re-match every job; editing skills does (final review I4)', async () => {
    const { profiles, matching, ids } = setup();
    const p = profiles.list()[0];
    await createMatchEvaluateHandler({ matching, profiles, onSurfaced: () => {} })({ jobIds: ids, profileId: p.id }, ctx);
    expect(matching.staleJobIds(p.id)).toEqual([]);
    const data = profiles.get(p.id)!.data;
    profiles.updateData(p.id, { ...data, personal: { ...data.personal, fullName: 'New Name', email: 'new@example.com', phone: '+1 555 0100' } }, { byUser: true });
    expect(matching.staleJobIds(p.id)).toEqual([]);
    profiles.updateData(p.id, { ...data, skills: [...data.skills, { id: '', name: 'Kafka', category: 'technology' }] }, { byUser: true });
    expect(matching.staleJobIds(p.id).length).toBeGreaterThan(0);
  });

  it('reconciliation queues jobs left unmatched, once', async () => {
    const { queue, profiles, matching, ids } = setup();
    await createMatchEvaluateHandler({ matching, profiles, onSurfaced: () => {} })({ jobIds: ids.slice(0, 10) }, ctx);
    expect(reconcileMatches({ matching, profiles, queue })).toBeGreaterThan(0);
    const queued = queue.counts(MATCH_TASK).pending;
    // While matching is still queued, reconciling again adds nothing.
    expect(reconcileMatches({ matching, profiles, queue })).toBe(0);
    expect(queue.counts(MATCH_TASK).pending).toBe(queued);
    const first = queue.claim('w', [MATCH_TASK])?.payload as { jobIds: number[] };
    expect(first.jobIds).not.toContain(ids[0]);
  });
});
