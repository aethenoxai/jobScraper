import { z } from 'zod';
import type { JobSourceAdapter } from '../types';

/** Holds jobs the user added by URL or pasted by hand. It never fetches anything itself. */
export const manual: JobSourceAdapter<Record<string, never>> = {
  id: 'manual',
  displayName: 'Added by you',
  description: 'Jobs you added by link or pasted yourself.',
  homepage: 'https://job-scraper.local',
  hidden: true,
  configFields: [],
  configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  minIntervalMinutes: 60 * 24 * 365,
  async *fetch() {},
};
