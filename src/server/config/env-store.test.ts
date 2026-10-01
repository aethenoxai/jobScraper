import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubSecrets } from '../logging';
import { loadEnvFiles } from './env-files';
import { envFileFor, liveEnv, shellDefines, writeEnvValue } from './env-store';

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-env-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string) => path.join(dir, name);
const read = (name = '.env') => readFileSync(file(name), 'utf8');
const opts = () => ({ mode: 'production' as const, dir });

describe('writeEnvValue: a key typed in the app goes into .env', () => {
  it('replaces the existing line and keeps comments, other settings and the order', () => {
    writeFileSync(file('.env'), '# AI keys\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=old # mine\nPORT=3000\n');
    writeEnvValue('ANTHROPIC_API_KEY', 'sk-ant-new-123', opts());
    expect(read()).toBe('# AI keys\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=sk-ant-new-123\nPORT=3000\n');
  });

  it('keeps an export prefix and Windows line endings', () => {
    writeFileSync(file('.env'), 'PORT=3000\r\nexport OPENAI_API_KEY=old\r\n');
    writeEnvValue('OPENAI_API_KEY', 'sk-new-123', opts());
    expect(read()).toBe('PORT=3000\r\nexport OPENAI_API_KEY=sk-new-123\r\n');
  });

  it('changes the line that counts when a key is listed twice (the last one)', () => {
    writeFileSync(file('.env'), 'OPENAI_API_KEY=a\nOPENAI_API_KEY=b\n');
    writeEnvValue('OPENAI_API_KEY', 'sk-c-123456', opts());
    expect(read()).toBe('OPENAI_API_KEY=a\nOPENAI_API_KEY=sk-c-123456\n');
  });

  it('adds the key at the end when it is missing, and creates .env if there is none', () => {
    writeFileSync(file('.env'), 'PORT=3000');
    writeEnvValue('GOOGLE_GENERATIVE_AI_API_KEY', 'AIza-123456', opts());
    expect(read()).toBe('PORT=3000\nGOOGLE_GENERATIVE_AI_API_KEY=AIza-123456\n');
    rmSync(file('.env'));
    expect(writeEnvValue('OPENAI_API_KEY', 'sk-123456', opts())).toBe(file('.env'));
    expect(read()).toBe('OPENAI_API_KEY=sk-123456\n');
  });

  it('quotes values with #, $ or spaces so .env reads them back unchanged', () => {
    writeEnvValue('OPENAI_COMPATIBLE_API_KEY', 'ab#c $d e', opts());
    expect(read()).toBe("OPENAI_COMPATIBLE_API_KEY='ab#c $d e'\n");
    const env: Record<string, string | undefined> = {};
    loadEnvFiles('production', dir, env);
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe('ab#c $d e');
  });

  it('refuses values that would break the file (line breaks, quotes) and odd variable names', () => {
    expect(() => writeEnvValue('OPENAI_API_KEY', 'a\nPORT=1', opts())).toThrow(/line break|quote/i);
    expect(() => writeEnvValue('OPENAI_API_KEY', "a'b\"c", opts())).toThrow(/line break|quote/i);
    expect(() => writeEnvValue('bad name', 'x', opts())).toThrow(/name/i);
  });

  it('writes to the file that already sets the key (.env.local wins over .env)', () => {
    writeFileSync(file('.env'), 'OPENAI_API_KEY=\n');
    writeFileSync(file('.env.local'), 'OPENAI_API_KEY=old\n');
    expect(envFileFor('OPENAI_API_KEY', 'production', dir)).toBe(file('.env.local'));
    writeEnvValue('OPENAI_API_KEY', 'sk-new-123', opts());
    expect(read('.env.local')).toBe('OPENAI_API_KEY=sk-new-123\n');
    expect(read('.env')).toBe('OPENAI_API_KEY=\n');
  });

  it.skipIf(process.platform === 'win32')('leaves the file readable only by the user', () => {
    writeFileSync(file('.env'), 'PORT=1\n', { mode: 0o644 });
    writeEnvValue('OPENAI_API_KEY', 'sk-123456', opts());
    expect(statSync(file('.env')).mode & 0o777).toBe(0o600);
  });
});

describe('liveEnv: keys added to .env work without a restart', () => {
  it('sees a value written after start, and a changed one', () => {
    writeFileSync(file('.env'), 'PORT=3000\n');
    const env: Record<string, string | undefined> = {};
    loadEnvFiles('production', dir, env);
    expect(liveEnv({ env }).OPENAI_API_KEY).toBeUndefined();
    writeEnvValue('OPENAI_API_KEY', 'sk-first-123', opts());
    expect(liveEnv({ env }).OPENAI_API_KEY).toBe('sk-first-123');
    writeFileSync(file('.env'), 'PORT=3000\nOPENAI_API_KEY=sk-second-123\n');
    // Same size and second: make sure a change is still noticed.
    const later = new Date(Date.now() + 5000);
    utimesSync(file('.env'), later, later);
    expect(liveEnv({ env }).OPENAI_API_KEY).toBe('sk-second-123');
  });

  it('forgets a key removed from the file', () => {
    writeFileSync(file('.env'), 'OPENAI_API_KEY=sk-gone-123\n');
    const env: Record<string, string | undefined> = {};
    loadEnvFiles('production', dir, env);
    writeFileSync(file('.env'), 'PORT=1\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(file('.env'), later, later);
    expect(liveEnv({ env }).OPENAI_API_KEY).toBeUndefined();
  });

  it('a value set in the shell wins over the file, and an empty one counts as not set', () => {
    writeFileSync(file('.env'), 'PORT=3000\n');
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-shell-123', ANTHROPIC_API_KEY: '' };
    loadEnvFiles('production', dir, env);
    expect(shellDefines('OPENAI_API_KEY', env)).toBe(true);
    expect(shellDefines('ANTHROPIC_API_KEY', env)).toBe(false);
    writeEnvValue('OPENAI_API_KEY', 'sk-file-123', opts());
    writeEnvValue('ANTHROPIC_API_KEY', 'sk-ant-file-123', opts());
    const live = liveEnv({ env });
    expect(live.OPENAI_API_KEY).toBe('sk-shell-123');
    expect(live.ANTHROPIC_API_KEY).toBe('sk-ant-file-123');
    expect(shellDefines('ANTHROPIC_API_KEY', env)).toBe(false);
  });

  it('keeps new keys out of the logs', () => {
    const env: Record<string, string | undefined> = {};
    loadEnvFiles('production', dir, env);
    writeEnvValue('OPENAI_API_KEY', 'sk-never-logged-987', opts());
    liveEnv({ env });
    expect(scrubSecrets('key sk-never-logged-987 failed')).toBe('key [REDACTED] failed');
  });
});
