import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path]);
    return true;
  } catch {
    return false;
  }
}

describe('repo hygiene', () => {
  it('never commits local secrets or user data', () => {
    expect(isIgnored('.env')).toBe(true);
    expect(isIgnored('data/job-scraper.db')).toBe(true);
    expect(isIgnored('data/files/applications/1/cv.pdf')).toBe(true);
  });

  it('does commit .env.example', () => {
    expect(isIgnored('.env.example')).toBe(false);
  });

  it('ships an .env.example without real secret values', () => {
    const lines = readFileSync('.env.example', 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [key, ...rest] = line.split('=');
      if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) expect(rest.join('=').trim()).toBe('');
    }
  });

  const tracked = () => execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  /** Working notes for the maintainer and their assistant; never published (see docs/RELEASING.md). */
  const INTERNAL = new Set(['MEMORY.md', 'CLAUDE.md', 'AGENTS.md', 'HANDOVER.md']);

  it('tracks no secrets, user data or local build output', () => {
    const files = tracked();
    expect(files.filter((f) => f === '.env' || /^\.env\.(?!example$)/.test(f))).toEqual([]);
    expect(files.filter((f) => /^(data|\.e2e-data|\.next|test-results)\//.test(f))).toEqual([]);
  });

  it('contains no real people’s email addresses: tests use invented ones', () => {
    // Invented addresses on real providers' domains (needed to test free-mail handling) and public role inboxes in
    // recorded job-board responses. Anything else must use example/test domains.
    const allowed = new Set(['a@gmail.com', 'a@x.com', 'acmehiring@gmail.com', 'asha@gmail.com', 'me@gmail.com', 'me@outlook.com', 'mom@gmail.com', 'someone@gmail.com', 'you@gmail.com', 'priya.nair.example@gmail.com', 'accommodations@palantir.com', 'alerts@greenhouse.io', 'calendar-notification@google.com', 'jobalerts-noreply@linkedin.com', 'no-reply@ashbyhq.com', 'no-reply@us.greenhouse-mail.io', 'notifications@github.com']);
    const synthetic = /@(?:[a-z0-9-]+\.)*(?:example|test|invalid|local|localhost)$|@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$|^job\.[a-z0-9]+@[a-z0-9-]+\.recruitee\.com$/;
    const found: string[] = [];
    for (const f of tracked()) {
      if (INTERNAL.has(f) || /\.(png|jpe?g|pdf|docx|ico|woff2?)$|pnpm-lock\.yaml$/.test(f) || !existsSync(f)) continue;
      for (const m of readFileSync(f, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        const email = m[0].toLowerCase();
        if (!synthetic.test(email) && !allowed.has(email)) found.push(`${f}: ${email}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every relative link in the published docs points to a file that exists', () => {
    // .claude/skills holds vendored agent skills (Scrapling's own docs, copied as published upstream): not our docs.
    const docs = tracked().filter((f) => f.endsWith('.md') && !INTERNAL.has(f) && !f.startsWith('docs/superpowers/') && !f.startsWith('.github/') && !f.startsWith('.claude/skills/'));
    const broken: string[] = [];
    for (const f of docs) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(path.join(path.dirname(f), target))) broken.push(`${f} → ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
