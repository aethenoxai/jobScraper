/**
 * API keys typed into the app are saved in the env files (PRD §37: keys live only there, never in the database or
 * backups), and both processes pick them up without a restart.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { registerSecret } from '../logging';
import { collectSecrets } from './index';
import { envFiles, envFileState, envFilesSignature, runMode, setEnvFileState, type Mode } from './env-files';

const NAME = /^[A-Z][A-Z0-9_]*$/;

/** The file to write a variable to: the most specific one that already sets it (it would win), otherwise `.env`. */
export function envFileFor(key: string, mode: Mode, dir: string = process.cwd()): string {
  for (const f of envFiles(mode)) {
    const full = path.join(dir, f);
    if (existsSync(full) && Object.prototype.hasOwnProperty.call(parseEnv(readFileSync(full, 'utf8')), key)) return full;
  }
  return path.join(dir, '.env');
}

/** As written in the file: plain when safe, otherwise in single quotes (as CONFIGURATION.md tells people to do). */
function formatValue(value: string): string {
  return /^[A-Za-z0-9_\-.:/+=@,]*$/.test(value) ? value : `'${value}'`;
}

/** Sets one variable in its env file, keeping every other line. Atomic, and readable only by the user. Returns the file. */
export function writeEnvValue(key: string, value: string, opts: { mode?: Mode; dir?: string } = {}): string {
  if (!NAME.test(key)) throw new Error(`Not a valid variable name: ${key}`);
  if (/[\r\n'"`]/.test(value)) throw new Error('The value contains a line break or quote, which the .env file cannot hold.');
  const dir = opts.dir ?? process.cwd();
  const file = envFileFor(key, opts.mode ?? envFileState(process.env)?.mode ?? runMode(), dir);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before === '' ? [] : before.split(/\r?\n/);
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);
  let at = -1;
  lines.forEach((line, i) => {
    if (pattern.test(line)) at = i; // the last one counts
  });
  const line = (prefix: string) => `${prefix}${key}=${formatValue(value)}`;
  if (at >= 0) lines[at] = line(lines[at].match(pattern)![1]);
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(line(''), '');
  }
  if (lines.at(-1) !== '') lines.push('');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join(eol), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  registerSecret(value);
  return file;
}

/** True when the variable has a value that was set in the shell (not read from an env file): that value wins. */
export function shellDefines(key: string, env: Record<string, string | undefined> = process.env): boolean {
  return !!env[key] && !envFileState(env)?.fromFiles.has(key);
}

/**
 * The environment with the env files' current values: re-read when a file changed since the last look. Values set in
 * the shell are never replaced; an empty shell value counts as not set. New secret values are kept out of logs.
 */
export function liveEnv(opts: { env?: Record<string, string | undefined>; mode?: Mode; dir?: string } = {}): Record<string, string | undefined> {
  const env = opts.env ?? process.env;
  const known = envFileState(env);
  const mode = opts.mode ?? known?.mode ?? runMode();
  const dir = opts.dir ?? known?.dir ?? process.cwd();
  const signature = envFilesSignature(mode, dir);
  if (known && known.signature === signature && known.mode === mode && known.dir === dir) return env;

  const fromFiles = known?.fromFiles ?? new Set<string>();
  const values: Record<string, string> = {};
  for (const f of envFiles(mode)) {
    const full = path.join(dir, f);
    if (!existsSync(full)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(full, 'utf8')))) if (!(key in values) && value !== undefined) values[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (env[key] && !fromFiles.has(key)) continue; // set in the shell
    env[key] = value;
    fromFiles.add(key);
  }
  for (const key of [...fromFiles]) {
    if (key in values) continue;
    delete env[key];
    fromFiles.delete(key);
  }
  for (const secret of collectSecrets(env)) registerSecret(secret);
  setEnvFileState(env, { mode, dir, fromFiles, signature });
  return env;
}
