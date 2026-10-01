/**
 * The Docker setup's safety-relevant settings (PLAN §6.6). Docker itself isn't needed to check them: the files must
 * keep the UI on this computer, keep secrets and personal data out of the image, and run as a normal user.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requirePasswordForHost } from '../src/server/access';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const ignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim());
const playwrightVersion = JSON.parse(readFileSync('node_modules/playwright/package.json', 'utf8')).version as string;

describe('Docker setup', () => {
  it('publishes the web UI on this computer only, and listens on all interfaces only inside the container', () => {
    expect(compose).toMatch(/^\s*-\s*"127\.0\.0\.1:3000:3000"\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?(?:0\.0\.0\.0:)?3000:3000"?\s*$/m);
    // environment wins over env_file, so a HOST=127.0.0.1 in .env can't make the container unreachable.
    expect(compose).toMatch(/environment:[\s\S]*HOST: 0\.0\.0\.0[\s\S]*JOB_SCRAPER_IN_DOCKER: "true"/);
    expect(requirePasswordForHost('0.0.0.0', { JOB_SCRAPER_IN_DOCKER: 'true' })).toBeNull();
  });

  it('keeps data in a volume, applies with a hidden browser, and gives Chromium enough shared memory', () => {
    expect(compose).toMatch(/-\s*job-scraper-data:\/app\/data/);
    expect(compose).toMatch(/JOB_SCRAPER_BROWSER_HEADLESS: "true"/);
    expect(compose).toMatch(/shm_size: 1gb/);
    // An init process reaps browser processes; the time zone reaches the app.
    expect(compose).toMatch(/init: true/);
    expect(compose).toMatch(/TZ: \$\{TZ:-UTC\}/);
  });

  it('never copies secrets or personal data into the image', () => {
    for (const p of ['.env', '.env.*', 'data', '.e2e-data', '.git', '.superpowers']) expect(ignore).toContain(p);
    expect(ignore).toContain('!.env.example');
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env\b/);
  });

  it('ships Scrapling (Python) for reading job pages, in its own environment outside the app folder', () => {
    expect(dockerfile).toMatch(/python3 -m venv \/opt\/scrapling/);
    expect(dockerfile).toMatch(/\/opt\/scrapling\/bin\/pip install[^\n]*-r \/tmp\/scrapling-requirements\.txt/);
    expect(dockerfile).toMatch(/\/opt\/scrapling\/bin\/python -m playwright install --with-deps chromium/);
    expect(dockerfile).toMatch(/^ENV SCRAPLING_PYTHON=\/opt\/scrapling\/bin\/python$/m);
    expect(dockerfile).toMatch(/chmod -R a\+rX \/opt\/scrapling \/ms-playwright/);
    expect(ignore).toContain('.scrapling');
  });

  it('runs as a normal user on the pinned Node version, with a health check', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK[\s\S]*\/api\/health/m);
    expect(dockerfile.match(/^FROM node:(\d+)-/gm)).toEqual([`FROM node:${readFileSync('.nvmrc', 'utf8').trim()}-`, `FROM node:${readFileSync('.nvmrc', 'utf8').trim()}-`]);
    // Chromium comes from the project's own Playwright version (no separate base image to keep in step).
    expect(dockerfile).toMatch(/pnpm exec playwright install --with-deps chromium/);
    // pnpm is prepared while building (COREPACK_HOME readable by the node user), so starting needs no internet.
    expect(dockerfile).toMatch(/COREPACK_HOME=\/corepack/);
    expect(dockerfile).toMatch(/corepack install/);
    expect(dockerfile).toMatch(/chmod -R a\+rX \/corepack/);
    expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
