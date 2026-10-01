import { desc } from 'drizzle-orm';
import type { Db } from '../db';
import { scanRuns } from '../db/schema';

export type ScanRun = typeof scanRuns.$inferSelect;

export function listRecentScanRuns(db: Db, limit = 10): ScanRun[] {
  return db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt), desc(scanRuns.id)).limit(limit).all();
}
