import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { loadEnvFiles, runMode } from './config/env-files';
import { openDb } from './db';

export function runSetup(root: string = process.cwd(), env: Record<string, string | undefined> = process.env): { envCreated: boolean; dbPath: string } {
  const envPath = path.join(root, '.env');
  const envCreated = !existsSync(envPath);
  if (envCreated) copyFileSync(path.join(root, '.env.example'), envPath);
  // .env will hold API keys and passwords: readable only by the user.
  if (process.platform !== 'win32') chmodSync(envPath, 0o600);

  // The same files as the web page and worker (.env.local, .env.production, .env); a value in the shell wins.
  const merged: Record<string, string | undefined> = { ...env };
  loadEnvFiles(runMode(), root, merged);
  const config = loadConfig({ ...merged, DATA_DIR: path.resolve(root, merged.DATA_DIR || './data') });

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.filesDir, { recursive: true, mode: 0o700 });
  openDb(config.dbPath).close();
  return { envCreated, dbPath: config.dbPath };
}
