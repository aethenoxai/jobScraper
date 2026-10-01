import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

type Mode = 'production' | 'development' | 'test';

/** The env files Next.js reads for the web page, most specific first (its documented load order). */
export function envFiles(mode: Mode): string[] {
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

/**
 * Loads the env files into `env` the way the web page gets them, so the worker and the scripts see the same
 * settings. A value already set (in the shell, or by a more specific file) is never replaced.
 */
export function loadEnvFiles(mode: Mode, dir: string = process.cwd(), env: Record<string, string | undefined> = process.env): void {
  for (const file of envFiles(mode)) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(full, 'utf8')))) if (env[key] === undefined) env[key] = value;
  }
}

/** The mode a process runs in: NODE_ENV when set, otherwise production unless started for development. */
export function runMode(dev = false): Mode {
  const m = process.env.NODE_ENV;
  return m === 'production' || m === 'development' || m === 'test' ? m : dev ? 'development' : 'production';
}
