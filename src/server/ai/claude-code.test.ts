import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { childEnv, claudeCodeObject, claudeCodeStatus, findClaudeCode } from './claude-code';

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'job-scraper-claude-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in `claude` executable: records its arguments, stdin and environment, then answers as FAKE_MODE says.
 * It stands for the user's own installed Claude Code.
 */
function fakeClaude(mode: string, extra = ''): string {
  const bin = path.join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'call.json'))}, JSON.stringify({ args: process.argv.slice(2), input, env: process.env }));
  const mode = ${JSON.stringify(mode)};
  ${extra}
  if (process.argv[2] === 'auth') {
    if (mode === 'logged-out') { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Secret Org', subscriptionType: 'max' }));
    return;
  }
  // Like the real CLI (2.1.x): its validator doesn't know the 2020-12 meta-schema.
  const schemaArg = process.argv[process.argv.indexOf('--json-schema') + 1] || '';
  if (schemaArg.includes('draft/2020-12')) { console.error('Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"'); process.exit(1); }
  if (mode === 'ok') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"name":"Asha"}', structured_output: { name: 'Asha' }, usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 15 } }));
  if (mode === 'error') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })); process.exit(1); }
  if (mode === 'garbage') { console.error('something broke'); process.exit(2); }
  if (mode === 'wrong-shape') console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { name: 42 }, usage: {} }));
  if (mode === 'slow') setTimeout(() => {}, 60_000);
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
const lastCall = () => JSON.parse(readFileSync(path.join(dir, 'call.json'), 'utf8')) as { args: string[]; input: string; env: Record<string, string> };
const schema = z.object({ name: z.string() });

describe('Claude through the user’s own Claude Code', () => {
  it('asks the installed claude for a structured answer, with tools, MCP and settings off, and the prompt on stdin', async () => {
    const bin = fakeClaude('ok');
    const r = await claudeCodeObject({ bin, model: 'haiku', system: 'Be brief.', prompt: 'Who?', schema });
    expect(r).toEqual({ object: { name: 'Asha' }, inputTokens: 150, outputTokens: 15 });
    const { args, input } = lastCall();
    expect(input).toBe('Who?');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(JSON.parse(flag('--json-schema'))).toMatchObject({ type: 'object', required: ['name'] });
    expect(flag('--model')).toBe('haiku');
    expect(flag('--system-prompt')).toBe('Be brief.');
    expect(flag('--tools')).toBe('');
    expect(flag('--setting-sources')).toBe('');
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config']));
  });

  it('reports what claude said when it fails (e.g. not signed in)', async () => {
    await expect(claudeCodeObject({ bin: fakeClaude('error'), model: 'haiku', prompt: 'p', schema })).rejects.toThrow(/Not logged in/);
    await expect(claudeCodeObject({ bin: fakeClaude('garbage'), model: 'haiku', prompt: 'p', schema })).rejects.toThrow(/exit code 2[\s\S]*something broke/);
  });

  it('refuses an answer that does not fit the schema', async () => {
    await expect(claudeCodeObject({ bin: fakeClaude('wrong-shape'), model: 'haiku', prompt: 'p', schema })).rejects.toThrow(/did not match/i);
  });

  it('stops a call that takes too long, or that was cancelled', async () => {
    const bin = fakeClaude('slow');
    const started = Date.now();
    await expect(claudeCodeObject({ bin, model: 'haiku', prompt: 'p', schema, timeoutMs: 300 })).rejects.toThrow(/took too long|timed out/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await expect(claudeCodeObject({ bin, model: 'haiku', prompt: 'p', schema, signal: abort.signal })).rejects.toThrow(/cancel/i);
  });

  it("does not hand Job Scraper's own secrets (from its .env) to claude", () => {
    const env = childEnv({ PATH: '/bin', HOME: '/home/me', SMTP_PASSWORD: 'pw-123456', ANTHROPIC_API_KEY: 'sk-ant-ours' }, new Set(['SMTP_PASSWORD', 'ANTHROPIC_API_KEY']));
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' });
  });

  it('status: installed and signed in (plan named, never the account e-mail or organisation)', async () => {
    const s = await claudeCodeStatus({ bin: fakeClaude('ok') });
    expect(s).toMatchObject({ installed: true, loggedIn: true });
    expect(s.message).toMatch(/max plan/i);
    expect(s.message).not.toMatch(/someone@example.com|Secret Org/);
  });

  it('status: signed out, or not installed, with what to do', async () => {
    expect(await claudeCodeStatus({ bin: fakeClaude('logged-out') })).toMatchObject({ installed: true, loggedIn: false, message: expect.stringMatching(/claude auth login/) });
    expect(await claudeCodeStatus({ bin: null })).toMatchObject({ installed: false, loggedIn: false, message: expect.stringMatching(/install/i) });
  });

  it('finds claude on the PATH', () => {
    fakeClaude('ok');
    expect(findClaudeCode({ PATH: `/nonexistent:${dir}`, HOME: '/nonexistent' })).toBe(path.join(dir, 'claude'));
    expect(findClaudeCode({ PATH: '/nonexistent', HOME: '/nonexistent' })).toBeNull();
  });
});
