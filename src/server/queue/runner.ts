import type { Logger } from '../logging';
import type { Queue } from './index';

export interface TaskContext {
  taskId: number;
  attempt: number;
  log: Logger;
  /** Aborted when the task times out or the worker shuts down. Pass it to fetch/AI/browser calls. */
  signal: AbortSignal;
}

export type TaskHandler = (payload: unknown, ctx: TaskContext) => Promise<void>;

export interface HandlerRegistration {
  handle: TaskHandler;
  concurrency?: number;
  /** Abort and fail the task after this long. */
  timeoutMs?: number;
}

export interface Runner {
  tick(): number;
  start(): void;
  /** Stops polling, aborts in-flight tasks (returning them to the queue) and waits at most `deadlineMs`. */
  stop(deadlineMs?: number): Promise<void>;
  idle(): Promise<void>;
}

export interface RunnerOptions {
  queue: Queue;
  handlers: Record<string, HandlerRegistration>;
  workerId: string;
  log: Logger;
  pollMs?: number;
}

export class TaskTimeoutError extends Error {
  override name = 'TaskTimeoutError';
}
export class ShutdownError extends Error {
  override name = 'ShutdownError';
}

/** True when a task's signal was aborted because the worker is stopping (the task will run again later). */
export function isShutdown(reason: unknown): boolean {
  return reason instanceof ShutdownError;
}

export function createRunner(opts: RunnerOptions): Runner {
  const inFlight = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const controllers = new Map<number, AbortController>();
  let timer: NodeJS.Timeout | null = null;

  const typesWithCapacity = () =>
    Object.entries(opts.handlers)
      .filter(([type, h]) => (inFlight.get(type) ?? 0) < (h.concurrency ?? 1))
      .map(([type]) => type);

  function tick(): number {
    let started = 0;
    for (;;) {
      const types = typesWithCapacity();
      if (types.length === 0) break;
      const task = opts.queue.claim(opts.workerId, types);
      if (!task) break;
      started++;
      inFlight.set(task.type, (inFlight.get(task.type) ?? 0) + 1);
      const log = opts.log.child({ taskId: task.id, taskType: task.type });
      const reg = opts.handlers[task.type];

      const ac = new AbortController();
      controllers.set(task.id, ac);
      const timeout = reg.timeoutMs
        ? setTimeout(() => ac.abort(new TaskTimeoutError(`Task timed out after ${reg.timeoutMs} ms`)), reg.timeoutMs)
        : null;
      const aborted = new Promise<never>((_, reject) =>
        ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true }),
      );
      const work = Promise.resolve().then(() =>
        reg.handle(task.payload, { taskId: task.id, attempt: task.attempts, log, signal: ac.signal }),
      );
      work.catch(() => {}); // a handler that rejects after being aborted is ignored

      const run: Promise<void> = Promise.race([work, aborted])
        .then(
          () => {
            try {
              opts.queue.complete(task.id);
            } catch (err) {
              // Don't fail (and re-run) work that succeeded; the task is recovered at the next start.
              log.error({ err }, 'task finished but its completion could not be recorded');
            }
          },
          (err: unknown) => {
            if (err instanceof ShutdownError) {
              opts.queue.release(task.id);
              log.info('task interrupted by shutdown; returned to the queue');
              return;
            }
            const outcome = opts.queue.fail(task.id, err);
            log.warn({ err, outcome }, 'task failed');
          },
        )
        .catch((err: unknown) => log.error({ err }, 'could not record task outcome'))
        .finally(() => {
          if (timeout) clearTimeout(timeout);
          controllers.delete(task.id);
          inFlight.set(task.type, (inFlight.get(task.type) ?? 1) - 1);
          running.delete(run);
        });
      running.add(run);
    }
    return started;
  }

  async function idle(): Promise<void> {
    while (running.size > 0) await Promise.allSettled([...running]);
  }

  return {
    tick,
    idle,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          tick();
        } catch (err) {
          opts.log.error({ err }, 'queue tick failed');
        }
      }, opts.pollMs ?? 1000);
    },
    async stop(deadlineMs = 10_000) {
      if (timer) clearInterval(timer);
      timer = null;
      for (const ac of controllers.values()) ac.abort(new ShutdownError('Worker shutting down'));
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([idle(), new Promise<void>((r) => (deadline = setTimeout(r, deadlineMs)))]);
      clearTimeout(deadline);
    },
  };
}
