import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createHttpClient } from '@/server/http';
import { createIngestor } from '@/server/jobs/ingest';
import { createLogger } from '@/server/logging';
import { DEFAULT_PREFERENCES } from '@/server/profile/model';
import { createProfileService } from '@/server/profile/service';
import { PermanentError } from '@/server/queue';
import { listRecentScanRuns } from '@/server/scans';
import { createSettings } from '@/server/settings';
import { registerAdapter } from '@/server/sources/registry';
import { createSourceService } from '@/server/sources/service';
import { createFileStore } from '@/server/storage';
import { createDiscoveryScanHandler } from './discovery-scan';

const log = createLogger({ level: 'silent' });
const ctx = { taskId: 1, attempt: 1, log, signal: new AbortController().signal };
let seenHints: string[] = [];
registerAdapter({
  id: 'h-test', displayName: 'h', description: 'h', homepage: 'https://h.example', configFields: [], configSchema: z.object({}), completeSnapshot: true, minIntervalMinutes: 1,
  async *fetch({ hints }) {
    seenHints = hints.titles;
    yield { sourceJobId: '1', sourceUrl: 'https://h.example/1', title: 'Nurse', company: 'Clinic', description: 'Care for patients' };
  },
});

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

function handler(onChangedJobs: (ids: number[]) => void = () => {}, canScan?: () => boolean) {
  const settings = createSettings(t.db);
  const sources = createSourceService({ db: t.db, settings });
  const profiles = createProfileService({ db: t.db, files: createFileStore(t.dir) });
  const h = createDiscoveryScanHandler({ db: t.db, sources, profiles, ingestor: createIngestor({ db: t.db }), http: createHttpClient({ minGapMs: 0 }), log, env: {}, ai: null, onChangedJobs, canScan });
  return { h, sources, profiles };
}

describe('discovery.scan handler', () => {
  it('runs the scan with hints from profiles and reports changed jobs', async () => {
    const changed: number[][] = [];
    const { h, sources, profiles } = handler((ids) => changed.push(ids));
    sources.create('h-test', 'H', {});
    const p = profiles.create('Nurse');
    profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Staff Nurse'] }, 100);
    await h({ trigger: 'manual' }, ctx);
    expect(seenHints).toEqual(['Staff Nurse']);
    expect(changed).toEqual([[1]]);
    const [run] = listRecentScanRuns(t.db);
    expect(run).toMatchObject({ trigger: 'manual', status: 'success', stats: expect.objectContaining({ sources: 1, new: 1 }) });
  });

  it('rejects malformed payloads permanently', async () => {
    await expect(handler().h({ trigger: 'whenever' }, ctx)).rejects.toBeInstanceOf(PermanentError);
  });

  it('does not search while onboarding is unfinished (a scan queued earlier is dropped)', async () => {
    const changed: number[][] = [];
    const { h, sources } = handler((ids) => changed.push(ids), () => false);
    sources.create('h-test', 'H', {});
    await h({ trigger: 'schedule' }, ctx);
    expect(changed).toEqual([]);
    expect(listRecentScanRuns(t.db)).toHaveLength(0);
  });
});
