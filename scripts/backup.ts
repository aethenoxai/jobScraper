/** pnpm backup — a consistent copy of the database and files into data/backups (the newest 10 are kept). */
import { createBackup } from '../src/server/backup';
import { loadConfig } from '../src/server/config';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';
import { openDb } from '../src/server/db';

loadEnvFiles(runMode());
const config = loadConfig();
const { sqlite, close } = openDb(config.dbPath);
createBackup({ dataDir: config.dataDir, dbPath: config.dbPath, filesDir: config.filesDir, sqlite })
  .then((dir) => console.log(`✓ Backup saved to ${dir}\n  (your .env file is not included; keep a copy of it somewhere safe too)`))
  .finally(close);
