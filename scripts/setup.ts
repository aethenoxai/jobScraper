import { spawnSync } from 'node:child_process';
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
console.log('\nNext: pnpm build && pnpm start  →  open http://127.0.0.1:3000');
