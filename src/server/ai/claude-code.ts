/**
 * Claude through the user's own Claude Code (D-25): Job Scraper runs the unmodified `claude` the user installed and
 * signed in to themselves, in non-interactive mode. It never signs in for the user and never reads Claude Code's
 * credentials; usage counts against the user's own Claude plan or key, as Anthropic's terms require.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { envFileState } from '../config/env-files';
import { scrubSecrets } from '../logging';

export interface ClaudeCodeStatus {
  installed: boolean;
  loggedIn: boolean;
  /** What to tell the user (never their account e-mail or organisation). */
  message: string;
}

const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The `claude` executable: on the PATH, or where its installers put it. */
export function findClaudeCode(env: Record<string, string | undefined> = process.env): string | null {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean)];
  if (env.HOME) dirs.push(path.join(env.HOME, '.claude', 'local'), path.join(env.HOME, '.local', 'bin'));
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

/** The environment for claude: the user's own, without the secrets Job Scraper read from its env files. */
export function childEnv(env: Record<string, string | undefined> = process.env, fromFiles: ReadonlySet<string> = envFileState(process.env)?.fromFiles ?? new Set()): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !fromFiles.has(e[0])));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { input?: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Its own empty working folder: no project files or instructions are picked up.
    const child = spawn(bin, args, { cwd: tmpdir(), env: (opts.env ?? childEnv()) as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stopped: Error | null = null;
    const stop = (err: Error) => {
      stopped ??= err;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    const timer = setTimeout(() => stop(new Error(`Claude Code took too long (more than ${Math.round(opts.timeoutMs / 1000)} s).`)), opts.timeoutMs);
    const onAbort = () => stop(new Error('The Claude Code call was cancelled.'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (stopped) reject(stopped);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // a child that exits early closes its stdin
    child.stdin.end(opts.input ?? '');
  });
}

const ResultSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z.object({ input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(), output_tokens: z.number().optional() }).partial().optional(),
});

const short = (s: string) => scrubSecrets(s.trim()).slice(0, 300);

/** One structured answer from Claude Code (`claude -p … --json-schema`). */
export async function claudeCodeObject<T>(req: { bin: string; model: string; system?: string; prompt: string; schema: z.ZodType<T>; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> }): Promise<{ object: T; inputTokens: number; outputTokens: number }> {
  if (req.signal?.aborted) throw new Error('The Claude Code call was cancelled.');
  // Draft 7: Claude Code's validator doesn't know the 2020-12 meta-schema (zod's default).
  const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' });
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(jsonSchema), '--model', req.model, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''];
  if (req.system) args.push('--system-prompt', req.system);
  const out = await run(req.bin, args, { input: req.prompt, timeoutMs: req.timeoutMs ?? 120_000, signal: req.signal, env: req.env });
  let parsed: z.infer<typeof ResultSchema>;
  try {
    parsed = ResultSchema.parse(JSON.parse(out.stdout));
  } catch {
    throw new Error(`Claude Code failed (exit code ${out.code}): ${short(out.stderr || out.stdout) || 'no output'}`);
  }
  if (parsed.is_error) throw new Error(`Claude Code: ${short(parsed.result ?? 'it reported an error')}`);
  const object = req.schema.safeParse(parsed.structured_output);
  if (!object.success) throw new Error('Claude Code’s answer did not match the expected structure.');
  const u = parsed.usage ?? {};
  return { object: object.data, inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 };
}

const NOT_INSTALLED = 'Claude Code isn’t installed on this computer. Install it (https://claude.com/claude-code), sign in with `claude auth login` in a terminal, then check again.';

/** Whether the user's Claude Code is installed and signed in (`claude auth status`). */
export async function claudeCodeStatus(opts: { bin?: string | null; env?: Record<string, string> } = {}): Promise<ClaudeCodeStatus> {
  const bin = opts.bin === undefined ? findClaudeCode() : opts.bin;
  if (!bin) return { installed: false, loggedIn: false, message: NOT_INSTALLED };
  try {
    const out = await run(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000, env: opts.env });
    const s = z.object({ loggedIn: z.boolean(), subscriptionType: z.string().nullish() }).safeParse(JSON.parse(out.stdout));
    if (s.success && s.data.loggedIn) return { installed: true, loggedIn: true, message: `Claude Code is signed in${s.data.subscriptionType ? ` (${s.data.subscriptionType} plan)` : ''}.` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, loggedIn: false, message: NOT_INSTALLED };
  }
  return { installed: true, loggedIn: false, message: 'Claude Code is installed but not signed in. Run `claude auth login` in a terminal, then check again.' };
}
