import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export type Mode = 'production' | 'development' | 'test';

/** What was loaded from the env files into an environment, so later reloads can tell file values from shell ones. */
export interface EnvFileState {
  mode: Mode;
  dir: string;
  /** Variables whose value came from a file (everything else was set in the shell). */
  fromFiles: Set<string>;
  /** The files' sizes and change times when last read. */
  signature: string;
}

// On globalThis: Next.js route bundles get their own copy of this module.
const holder = globalThis as typeof globalThis & { __jobScraperEnvFiles?: WeakMap<object, EnvFileState> };
export function envFileState(env: object): EnvFileState | undefined {
  return holder.__jobScraperEnvFiles?.get(env);
}
export function setEnvFileState(env: object, state: EnvFileState): void {
  (holder.__jobScraperEnvFiles ??= new WeakMap()).set(env, state);
}

/** Sizes and change times of the env files, to notice an edit cheaply. */
export function envFilesSignature(mode: Mode, dir: string): string {
  return envFiles(mode)
    .map((f) => {
      try {
        const st = statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join('|');
}

/** The env files Next.js reads for the web page, most specific first (its documented load order). */
export function envFiles(mode: Mode): string[] {
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

/**
 * Loads the env files into `env` the way the web page gets them, so the worker and the scripts see the same
 * settings. A value already set (in the shell, or by a more specific file) is never replaced.
 */
export function loadEnvFiles(mode: Mode, dir: string = process.cwd(), env: Record<string, string | undefined> = process.env): void {
  const fromFiles = envFileState(env)?.fromFiles ?? new Set<string>();
  for (const file of envFiles(mode)) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(full, 'utf8')))) {
      if (env[key] !== undefined) continue;
      env[key] = value;
      fromFiles.add(key);
    }
  }
  setEnvFileState(env, { mode, dir, fromFiles, signature: envFilesSignature(mode, dir) });
}

/** The mode a process runs in: NODE_ENV when set, otherwise production unless started for development. */
export function runMode(dev = false): Mode {
  const m = process.env.NODE_ENV;
  return m === 'production' || m === 'development' || m === 'test' ? m : dev ? 'development' : 'production';
}
