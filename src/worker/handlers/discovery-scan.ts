import { z } from 'zod';
import type { Ai } from '@/server/ai';
import type { FailureLog } from '@/server/failures';
import type { Db } from '@/server/db';
import { collectHints } from '@/server/discovery/hints';
import { runScan } from '@/server/discovery/scan';
import type { HttpClient } from '@/server/http';
import type { Ingestor } from '@/server/jobs/ingest';
import type { Logger } from '@/server/logging';
import type { ProfileService } from '@/server/profile/service';
import { PermanentError } from '@/server/queue';
import type { TaskHandler } from '@/server/queue/runner';
import type { SettingsStore } from '@/server/settings';
import type { SourceService } from '@/server/sources/service';

const PayloadSchema = z.object({ trigger: z.enum(['schedule', 'manual']) });

export interface DiscoveryDeps {
  db: Db;
  sources: SourceService;
  profiles: ProfileService;
  ingestor: Ingestor;
  http: HttpClient;
  log: Logger;
  env: Record<string, string | undefined>;
  ai: Ai | null;
  onChangedJobs: (jobIds: number[]) => void;
  /** Runs after each scan (e.g. matching reconciliation). */
  afterScan?: () => void;
  /** Scan-wide problems for the System page. */
  failures?: FailureLog;
  settings?: SettingsStore;
  /** False until onboarding is finished: a scan queued before (or by an old schedule) is dropped. */
  canScan?: () => boolean;
}

export function createDiscoveryScanHandler(deps: DiscoveryDeps): TaskHandler {
  return async (payload, { log, signal }) => {
    const parsed = PayloadSchema.safeParse(payload);
    if (!parsed.success) throw new PermanentError(`Invalid discovery.scan payload: ${parsed.error.message}`);
    if (deps.canScan && !deps.canScan()) {
      log.info({ trigger: parsed.data.trigger }, 'discovery scan skipped: setup is not finished');
      return;
    }
    const summary = await runScan({
      ...deps,
      log,
      signal,
      trigger: parsed.data.trigger,
      hints: collectHints(deps.profiles.list()),
    });
    log.info({ scanRunId: summary.scanRunId, status: summary.status, ...summary.stats }, 'discovery scan finished');
    deps.afterScan?.();
  };
}
