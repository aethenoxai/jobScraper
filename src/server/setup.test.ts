import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup } from './setup';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'job-scraper-setup-'));
  writeFileSync(path.join(root, '.env.example'), 'DATA_DIR=./data\nPORT=3000\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runSetup', () => {
  it('creates .env from the example, the data directory and the database', () => {
    const result = runSetup(root, {});
    expect(result.envCreated).toBe(true);
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('DATA_DIR=./data');
    expect(result.dbPath).toBe(path.join(root, 'data', 'job-scraper.db'));
    expect(existsSync(result.dbPath)).toBe(true);
    expect(existsSync(path.join(root, 'data', 'files'))).toBe(true);
  });

  it('never overwrites an existing .env', () => {
    writeFileSync(path.join(root, '.env'), 'DATA_DIR=./mydata\n');
    const result = runSetup(root, {});
    expect(result.envCreated).toBe(false);
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('DATA_DIR=./mydata\n');
    expect(result.dbPath).toBe(path.join(root, 'mydata', 'job-scraper.db'));
  });

  it('uses DATA_DIR from the shell like the web UI and worker do (it wins over .env)', () => {
    writeFileSync(path.join(root, '.env'), 'DATA_DIR=./mydata\n');
    const result = runSetup(root, { DATA_DIR: path.join(root, 'elsewhere') });
    expect(result.dbPath).toBe(path.join(root, 'elsewhere', 'job-scraper.db'));
    expect(existsSync(result.dbPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('creates .env and the data folder readable only by you (final review, ops I5)', () => {
    const result = runSetup(root, {});
    expect(statSync(path.join(root, '.env')).mode & 0o077).toBe(0);
    expect(statSync(path.join(root, 'data')).mode & 0o077).toBe(0);
    expect(statSync(path.join(root, 'data', 'files')).mode & 0o077).toBe(0);
    expect(statSync(result.dbPath).mode & 0o077).toBe(0);
  });
});
