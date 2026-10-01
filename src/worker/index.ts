import { loadConfig } from '@/server/config';
import { loadEnvFiles, runMode } from '@/server/config/env-files';
import { startWorker } from './start';

async function main() {
  // The same .env files as the web page (no .env at all: defaults apply; `pnpm run setup` creates one).
  loadEnvFiles(runMode(process.argv.includes('--dev')));
  // JOB_SCRAPER_SEED_SOURCES=false keeps a fresh install from contacting job sites (used by the E2E suite).
  const worker = await startWorker({ config: loadConfig(), seedDefaultSources: process.env.JOB_SCRAPER_SEED_SOURCES !== 'false' });
  // Ctrl+C reaches the whole process group, and a watcher or pnpm may pass it on again: stop once, ignore repeats.
  let stopping: Promise<void> | null = null;
  const shutdown = () => {
    stopping ??= worker.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Closing the terminal: stop the same way (and close the browsers).
  process.on('SIGHUP', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
