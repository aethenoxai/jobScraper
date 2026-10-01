import { spawnSync } from 'node:child_process';
import { loadEnvFiles, runMode } from '../src/server/config/env-files';
import { planScraplingInstall, runScraplingInstall, systemProbe } from '../src/server/scrapling/install';
import { runSetup } from '../src/server/setup';

const { envCreated, dbPath } = runSetup();
console.log(envCreated ? '✓ Created .env from .env.example (edit it to add API keys later)' : '✓ Found existing .env');
console.log(`✓ Database ready at ${dbPath}`);

// Tailored CVs are rendered to PDF with headless Chromium (also used later to apply on job sites).
if (process.env.JOB_SCRAPER_SKIP_BROWSER_INSTALL !== 'true') {
  console.log('… Installing Chromium for PDF rendering (one-time download)');
  const r = spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(r.status === 0 ? '✓ Chromium ready' : '⚠ Chromium could not be installed; run `pnpm exec playwright install chromium` later to create PDFs');
}

// Job pages (web discovery, "Add by link") are read with Scrapling, a Python library, in its own environment.
const env: Record<string, string | undefined> = { ...process.env };
loadEnvFiles(runMode(), process.cwd(), env);
console.log('… Setting up Scrapling to read job pages (Python; one-time download)');
const plan = planScraplingInstall({ env, root: process.cwd(), probe: systemProbe });
const problem = runScraplingInstall(plan);
if (problem) {
  console.log(`⚠ Scrapling could not be set up. ${problem}\n  Until it is, web discovery and "Add by link" can't read job pages (job boards still work).`);
  process.exitCode = 1;
} else {
  console.log(plan.kind === 'verify' ? `✓ Scrapling found (${plan.python})` : '✓ Scrapling ready');
}
console.log('\nNext: pnpm build && pnpm start  →  open http://127.0.0.1:3000');
