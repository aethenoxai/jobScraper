/** pnpm restore [backup folder] [--force] — lists backups, or restores one (Job Scraper must be stopped). */
import net from 'node:net';
import { createSettings } from '../src/server/settings';
import { listBackups, restoreBackup } from '../src/server/backup';
import { loadConfig } from '../src/server/config';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';
import { openDb } from '../src/server/db';
import { HEARTBEAT_KEY, HeartbeatSchema, isWorkerOnline } from '../src/server/status/heartbeat';

loadEnvFiles(runMode());
const config = loadConfig();
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
if (!target) {
  const all = listBackups(config.dataDir);
  console.log(all.length ? `Backups (newest first):\n${all.map((b) => `  ${b.dir}  (${b.createdAt.toLocaleString()}, ${b.label})`).join('\n')}\n\nRestore one with: pnpm restore <folder>` : 'No backups yet. Create one with: pnpm backup');
  process.exit(0);
}
const { db, close } = openDb(config.dbPath);
const hb = createSettings(db).get(HEARTBEAT_KEY, HeartbeatSchema.nullable(), null);
close();
if (isWorkerOnline(hb, new Date())) {
  console.error('Job Scraper is running. Stop it first (Ctrl+C in its terminal), then restore.');
  process.exit(1);
}

/** Whether something accepts connections on the web port (the web page can run without the worker). */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port, timeout: 700 });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// tsx runs scripts as CommonJS: no top-level await.
void (async () => {
  if (!force && (await answers(config.host, config.port))) {
    console.error(`Something is answering on http://${config.host}:${config.port}, probably Job Scraper's web page. Stop Job Scraper first (Ctrl+C in its terminal), then restore.\nIf it is another program, run: pnpm restore ${target} --force`);
    process.exit(1);
  }
  const aside = restoreBackup(target, { dataDir: config.dataDir, dbPath: config.dbPath, filesDir: config.filesDir });
  console.log(`✓ Restored ${target}\n  The data it replaced is in ${aside} (delete it once you're happy).`);
})();
