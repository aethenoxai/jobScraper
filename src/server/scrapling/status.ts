import { z } from 'zod';
import type { SettingsStore } from '../settings';
import type { HelperStatus } from './client';

/** Written by the worker whenever it starts the Scrapling helper (or fails to); the System page reads it. */
export const SCRAPLING_STATUS_KEY = 'scrapling.status';

const StatusSchema = z.object({ ready: z.boolean(), scrapling: z.string().nullable(), python: z.string().nullable(), error: z.string().nullable(), checkedAt: z.number() });
export type ScraplingStatus = z.infer<typeof StatusSchema>;

export function statusFromHelper(status: HelperStatus, now: number = Date.now()): ScraplingStatus {
  return status.ready
    ? { ready: true, scrapling: status.info.scrapling, python: status.info.python, error: null, checkedAt: now }
    : { ready: false, scrapling: null, python: null, error: status.error, checkedAt: now };
}

export function readScraplingStatus(settings: SettingsStore): ScraplingStatus | null {
  return settings.get(SCRAPLING_STATUS_KEY, StatusSchema.nullable(), null);
}

export function writeScraplingStatus(settings: SettingsStore, status: ScraplingStatus): void {
  settings.set(SCRAPLING_STATUS_KEY, status);
}
