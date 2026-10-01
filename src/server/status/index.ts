import type { Db } from '../db';
import type { Queue, TaskStatus } from '../queue';
import { listRecentScanRuns, type ScanRun } from '../scans';
import type { Scheduler, SchedulerState } from '../scheduler';
import type { SettingsStore } from '../settings';
import { HEARTBEAT_KEY, HeartbeatSchema, isProcessAlive, isWorkerOnline } from './heartbeat';

export interface SystemStatus {
  /** When this snapshot was taken (epoch ms); pages use it as "now" for relative times. */
  generatedAt: number;
  worker: { online: boolean; lastSeenAt: number | null };
  scheduler: SchedulerState;
  lastScan: ScanRun | null;
  recentScans: ScanRun[];
  queue: Record<TaskStatus, number>;
}

export function getSystemStatus(
  deps: { db: Db; settings: SettingsStore; queue: Queue; scheduler: Scheduler },
  opts: { now?: Date; isAlive?: (pid: number) => boolean } = {},
): SystemStatus {
  const now = opts.now ?? new Date();
  const hb = deps.settings.get(HEARTBEAT_KEY, HeartbeatSchema.nullable(), null);
  const recentScans = listRecentScanRuns(deps.db, 10);
  return {
    generatedAt: now.getTime(),
    worker: {
      online: isWorkerOnline(hb, now, opts.isAlive ?? isProcessAlive),
      lastSeenAt: hb && hb.at > 0 ? hb.at : null,
    },
    scheduler: deps.scheduler.getState(),
    lastScan: recentScans[0] ?? null,
    recentScans,
    queue: deps.queue.counts(),
  };
}
