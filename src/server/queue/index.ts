import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { scrubSecrets } from '../logging';
import { queueTasks, TASK_STATUSES } from '../db/schema';

export type Task = typeof queueTasks.$inferSelect;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** Not a failure: run the task again after a delay (quiet hours, a rate limit with a known wait). */
export class RetryLaterError extends Error {
  override name = 'RetryLaterError';
  constructor(
    readonly delayMs: number,
    message = 'Retry later',
  ) {
    super(message);
  }
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
}

export interface Queue {
  enqueue(type: string, payload: unknown, opts?: EnqueueOptions): { id: number; deduped: boolean };
  claim(workerId: string, types?: readonly string[]): Task | null;
  complete(id: number): void;
  fail(id: number, error: unknown): 'retrying' | 'failed';
  /** Returns a running task to the queue without counting it as a failure (e.g. on shutdown). */
  release(id: number): void;
  recoverStale(olderThanMs: number): number;
  get(id: number): Task | null;
  /** Newest tasks of a type (for showing progress of user-started work). */
  recent(type: string, limit: number): Task[];
  /** Cancels waiting tasks of a type whose payload matches (e.g. scheduled scans after Stop). Returns how many. */
  cancelPending(type: string, match?: (payload: unknown) => boolean): number;
  /** Tasks per status, optionally for one task type. */
  counts(type?: string): Record<TaskStatus, number>;
  /** Overwrites the payload of every task of a type whose payload matches, whatever its status (e.g. private text of deleted data). */
  replacePayloads(type: string, match: (payload: unknown) => boolean, payload: unknown): number;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQueue(db: Db, opts: { now?: () => Date } = {}): Queue {
  const now = opts.now ?? (() => new Date());

  return {
    enqueue(type, payload, options = {}) {
      return db.transaction(
        (tx) => {
          if (options.dedupeKey) {
            const active = tx
              .select({ id: queueTasks.id })
              .from(queueTasks)
              .where(and(eq(queueTasks.dedupeKey, options.dedupeKey), inArray(queueTasks.status, ['pending', 'running'])))
              .get();
            if (active) return { id: active.id, deduped: true };
          }
          const t = now();
          const row = tx
            .insert(queueTasks)
            .values({
              type,
              payload,
              status: 'pending',
              attempts: 0,
              maxAttempts: options.maxAttempts ?? 3,
              runAt: options.runAt ?? t,
              dedupeKey: options.dedupeKey ?? null,
              createdAt: t,
              updatedAt: t,
            })
            .returning({ id: queueTasks.id })
            .get();
          return { id: row.id, deduped: false };
        },
        { behavior: 'immediate' },
      );
    },

    claim(workerId, types) {
      if (types && types.length === 0) return null;
      return db.transaction(
        (tx) => {
          const t = now();
          const conditions = [eq(queueTasks.status, 'pending' as const), lte(queueTasks.runAt, t)];
          if (types) conditions.push(inArray(queueTasks.type, [...types]));
          const row = tx
            .select()
            .from(queueTasks)
            .where(and(...conditions))
            .orderBy(asc(queueTasks.runAt), asc(queueTasks.id))
            .limit(1)
            .get();
          if (!row) return null;
          const claimed = { status: 'running' as const, attempts: row.attempts + 1, lockedAt: t, lockedBy: workerId, updatedAt: t };
          tx.update(queueTasks).set(claimed).where(eq(queueTasks.id, row.id)).run();
          return { ...row, ...claimed };
        },
        { behavior: 'immediate' },
      );
    },

    complete(id) {
      db.update(queueTasks)
        .set({ status: 'done', lockedAt: null, lockedBy: null, updatedAt: now() })
        .where(eq(queueTasks.id, id))
        .run();
    },

    fail(id, error) {
      return db.transaction(
        (tx) => {
          const row = tx.select().from(queueTasks).where(eq(queueTasks.id, id)).get();
          if (!row) throw new Error(`Unknown task ${id}`);
          const t = now();
          if (error instanceof RetryLaterError) {
            tx.update(queueTasks)
              .set({ status: 'pending', runAt: new Date(t.getTime() + error.delayMs), attempts: Math.max(0, row.attempts - 1), lastError: error.message, lockedAt: null, lockedBy: null, updatedAt: t })
              .where(eq(queueTasks.id, id))
              .run();
            return 'retrying';
          }
          const giveUp = error instanceof PermanentError || row.attempts >= row.maxAttempts;
          tx.update(queueTasks)
            .set({
              status: giveUp ? 'failed' : 'pending',
              runAt: giveUp ? row.runAt : new Date(t.getTime() + backoffMs(row.attempts)),
              lastError: scrubSecrets(errorMessage(error)),
              lockedAt: null,
              lockedBy: null,
              updatedAt: t,
            })
            .where(eq(queueTasks.id, id))
            .run();
          return giveUp ? 'failed' : 'retrying';
        },
        { behavior: 'immediate' },
      );
    },

    release(id) {
      db.update(queueTasks)
        .set({ status: 'pending', attempts: sql`max(${queueTasks.attempts} - 1, 0)`, lockedAt: null, lockedBy: null, updatedAt: now() })
        .where(and(eq(queueTasks.id, id), eq(queueTasks.status, 'running')))
        .run();
    },

    recoverStale(olderThanMs) {
      return db.transaction(
        (tx) => {
          const t = now();
          const cutoff = new Date(t.getTime() - olderThanMs);
          const stale = tx
            .select()
            .from(queueTasks)
            .where(and(eq(queueTasks.status, 'running'), lte(queueTasks.lockedAt, cutoff)))
            .all();
          for (const task of stale) {
            // A task that keeps getting interrupted (e.g. it crashes the worker) must not block the queue forever.
            const exhausted = task.attempts >= task.maxAttempts;
            tx.update(queueTasks)
              .set({
                status: exhausted ? 'failed' : 'pending',
                lastError: exhausted ? `Interrupted ${task.attempts} times (the worker stopped or crashed while running it)` : task.lastError,
                lockedAt: null,
                lockedBy: null,
                updatedAt: t,
              })
              .where(eq(queueTasks.id, task.id))
              .run();
          }
          return stale.length;
        },
        { behavior: 'immediate' },
      );
    },

    cancelPending(type, match) {
      return db.transaction(
        (tx) => {
          const waiting = tx.select().from(queueTasks).where(and(eq(queueTasks.type, type), eq(queueTasks.status, 'pending'))).all();
          const targets = waiting.filter((task) => !match || match(task.payload));
          for (const task of targets) {
            tx.update(queueTasks).set({ status: 'failed', lastError: 'Cancelled', updatedAt: now() }).where(eq(queueTasks.id, task.id)).run();
          }
          return targets.length;
        },
        { behavior: 'immediate' },
      );
    },

    replacePayloads(type, match, payload) {
      return db.transaction(
        (tx) => {
          const targets = tx.select({ id: queueTasks.id, payload: queueTasks.payload }).from(queueTasks).where(eq(queueTasks.type, type)).all().filter((task) => match(task.payload));
          for (const task of targets) tx.update(queueTasks).set({ payload, updatedAt: now() }).where(eq(queueTasks.id, task.id)).run();
          return targets.length;
        },
        { behavior: 'immediate' },
      );
    },

    recent(type, limit) {
      return db.select().from(queueTasks).where(eq(queueTasks.type, type)).orderBy(desc(queueTasks.id)).limit(limit).all();
    },

    get(id) {
      return db.select().from(queueTasks).where(eq(queueTasks.id, id)).get() ?? null;
    },

    counts(type) {
      const rows = db
        .select({ status: queueTasks.status, n: count() })
        .from(queueTasks)
        .where(type ? eq(queueTasks.type, type) : undefined)
        .groupBy(queueTasks.status)
        .all();
      const out: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
  };
}
