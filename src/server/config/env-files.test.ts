import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envFiles, loadEnvFiles } from './env-files';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('env files (final review, ops minor)', () => {
  it('reads the same files as the web page (Next.js), most specific first', () => {
    expect(envFiles('production')).toEqual(['.env.production.local', '.env.local', '.env.production', '.env']);
    expect(envFiles('test')).toEqual(['.env.test.local', '.env.test', '.env']);
  });

  it('a value from a more specific file wins, and one set in the shell wins over every file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'js-env-'));
    writeFileSync(path.join(dir, '.env'), 'JS_T_A=env\nJS_T_B=env\nJS_T_C=env\n');
    writeFileSync(path.join(dir, '.env.local'), 'JS_T_A=local\nJS_T_C=local\n');
    const env: Record<string, string | undefined> = { JS_T_C: 'shell' };
    loadEnvFiles('production', dir, env);
    expect(env).toMatchObject({ JS_T_A: 'local', JS_T_B: 'env', JS_T_C: 'shell' });
  });
});
