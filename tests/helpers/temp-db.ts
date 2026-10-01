import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type DbHandle } from '@/server/db';

export function createTempDb(): DbHandle & { dir: string; file: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-test-'));
  const file = path.join(dir, 'test.db');
  const handle = openDb(file);
  return {
    ...handle,
    dir,
    file,
    cleanup() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
