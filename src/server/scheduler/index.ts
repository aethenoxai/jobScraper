import { z } from 'zod';
import type { Queue } from '../queue';
import type { SettingsStore } from '../settings';

export const SCHEDULER_KEY = 'scheduler';
export const SCAN_TASK = 'discovery.scan';
export const INTERVAL_PRESETS = [15, 30, 60, 120, 360] as const;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;
const MINUTE_MS = 60_000;

export const SchedulerStateSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(MIN_INTERVAL).max(MAX_INTERVAL),
  lastTriggeredAt: z.number().int().nullable(),
  nextRunAt: z.number().int().nullable(),
});
export type SchedulerState = z.infer<typeof SchedulerStateSchema>;

export const DEFAULT_SCHEDULER_STATE: SchedulerState = {
  enabled: false,
  // Most sources allow at most hourly checks (some only a few times a day): more often would mostly skip.
  intervalMinutes: 60,
  lastTriggeredAt: null,
  nextRunAt: null,
};

export function isValidInterval(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_INTERVAL && minutes <= MAX_INTERVAL;
}

export function describeInterval(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Every ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `Every ${minutes} minutes`;
}

export interface Scheduler {
  getState(): SchedulerState;
  start(): SchedulerState;
  stop(): SchedulerState;
  setIntervalMinutes(minutes: number): SchedulerState;
  runNow(): { id: number; deduped: boolean };
  tick(): boolean;
}

export function createScheduler(deps: { settings: SettingsStore; queue: Queue; now?: () => Date }): Scheduler {
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const update = (fn: (s: SchedulerState) => SchedulerState) =>
    deps.settings.update(SCHEDULER_KEY, SchedulerStateSchema, DEFAULT_SCHEDULER_STATE, fn);
  const enqueueScan = (trigger: 'schedule' | 'manual') =>
    deps.queue.enqueue(SCAN_TASK, { trigger }, { dedupeKey: SCAN_TASK });

  return {
    getState: () => deps.settings.get(SCHEDULER_KEY, SchedulerStateSchema, DEFAULT_SCHEDULER_STATE),

    start: () => update((s) => ({ ...s, enabled: true, nextRunAt: now() })),

    stop: () => {
      const state = update((s) => ({ ...s, enabled: false, nextRunAt: null }));
      // A scheduled scan still waiting (e.g. in retry backoff) must not run after Stop. Manual ones stay.
      deps.queue.cancelPending(SCAN_TASK, (p) => (p as { trigger?: string } | null)?.trigger === 'schedule');
      return state;
    },

    setIntervalMinutes(minutes) {
      if (!isValidInterval(minutes)) throw new RangeError(`Interval must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes`);
      return update((s) => {
        if (!s.enabled) return { ...s, intervalMinutes: minutes };
        const base = s.lastTriggeredAt ?? now();
        return { ...s, intervalMinutes: minutes, nextRunAt: Math.max(now(), base + minutes * MINUTE_MS) };
      });
    },

    runNow: () => enqueueScan('manual'),

    tick() {
      let due = false;
      // Queued inside the same transaction: the schedule only moves on if the scan is really queued.
      update((s) => {
        const t = now();
        if (!s.enabled || s.nextRunAt === null || t < s.nextRunAt) return s;
        due = true;
        enqueueScan('schedule');
        return { ...s, lastTriggeredAt: t, nextRunAt: t + s.intervalMinutes * MINUTE_MS };
      });
      return due;
    },
  };
}
