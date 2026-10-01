import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  // Tests share one app instance and database; run them in order.
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: [
    {
      // Web + worker against a throwaway data directory, in offline (no AI) mode, contacting no real job sites.
      // Email goes to the fixture SMTP server (STARTTLS with a self-signed certificate).
      command: `rm -rf .e2e-data && pnpm build && DATA_DIR=.e2e-data PORT=${PORT} JOB_SCRAPER_SEED_SOURCES=false JOB_SCRAPER_ALLOW_PRIVATE_URLS=true SMTP_HOST=127.0.0.1 SMTP_PORT=3198 SMTP_USERNAME=e2e@example.com SMTP_PASSWORD=e2e-pass SMTP_ALLOW_SELF_SIGNED=true JOB_SCRAPER_BROWSER_HEADLESS=true pnpm start`,
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    { command: 'node e2e/fixtures/site-server.mjs', url: 'http://127.0.0.1:3199/robots.txt', reuseExistingServer: false },
  ],
});
