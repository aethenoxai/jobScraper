import { hostname } from 'node:os';
import { z } from 'zod';

export const HEARTBEAT_KEY = 'worker.heartbeat';
export const HEARTBEAT_STALE_MS = 20_000;
/** A live worker process that beat within this window blocks another worker from starting (tolerates sleep/blocked loops). */
export const HEARTBEAT_GUARD_MS = 120_000;

/** `host`: the machine (or Docker container) the worker runs on; a pid means nothing on another one. */
export const HeartbeatSchema = z.object({ workerId: z.string(), pid: z.number().int(), at: z.number().int(), host: z.string().optional() });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the worker that wrote this heartbeat still runs. On this machine its process is checked; from another one
 * (e.g. `docker compose run` starts a new container) only a fresh heartbeat counts.
 */
export function heartbeatLive(hb: Heartbeat | null, now: Date, isAlive: (pid: number) => boolean = isProcessAlive, host: string = hostname(), withinMs = HEARTBEAT_STALE_MS): boolean {
  if (!hb) return false;
  const age = now.getTime() - hb.at;
  return hb.host && hb.host !== host ? age < HEARTBEAT_STALE_MS : age < withinMs && isAlive(hb.pid);
}

export function isWorkerOnline(hb: Heartbeat | null, now: Date, isAlive: (pid: number) => boolean = isProcessAlive, host: string = hostname()): boolean {
  return heartbeatLive(hb, now, isAlive, host);
}
