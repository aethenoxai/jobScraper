import { describe, expect, it } from 'vitest';
import { createLogger, registerSecret, scrub } from './index';

function capture() {
  const lines: string[] = [];
  return { lines, destination: { write: (s: string) => void lines.push(s) }, all: () => lines.join('\n') };
}

const KEY = 'sk-live-ABCDEF123456';

describe('logger', () => {
  it('redacts sensitive fields at any common depth', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination });
    log.info({ apiKey: KEY, smtp: { password: 'hunter2hunter2' }, headers: { authorization: 'Bearer xyz' } }, 'config');
    const line = JSON.parse(out.lines[0]);
    expect(line.apiKey).toBe('[REDACTED]');
    expect(line.smtp.password).toBe('[REDACTED]');
    expect(line.headers.authorization).toBe('[REDACTED]');
  });

  it('scrubs known secret values from messages', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination, secrets: [KEY] });
    log.warn(`provider rejected key ${KEY}`);
    expect(out.all()).not.toContain(KEY);
    expect(out.all()).toContain('[REDACTED]');
  });

  it('scrubs secret values inside error messages', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination, secrets: [KEY] });
    log.error({ err: new Error(`401 Unauthorized for key ${KEY}`) }, 'AI call failed');
    expect(out.all()).not.toContain(KEY);
    expect(JSON.parse(out.lines[0]).err.message).toContain('[REDACTED]');
  });

  it('scrubs secrets when an error is logged directly (log.error(err))', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination, secrets: [KEY] });
    log.error(new Error(`direct ${KEY}`));
    expect(out.all()).not.toContain(KEY);
  });

  it('scrubs secrets in extra error properties, nested strings and child bindings', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination, secrets: [KEY] });
    const err = Object.assign(new Error('call failed'), { url: `https://api.example/bot${KEY}/send`, responseBody: `{"key":"${KEY}"}` });
    log.error({ err }, 'boom');
    log.info({ request: { url: `https://x.example/?key=${KEY}` } }, 'nested');
    log.child({ token_hint: KEY }).info('child');
    expect(out.all()).not.toContain(KEY);
  });

  it('redacts x-api-key and capitalised Authorization headers', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination });
    log.info({ headers: { 'x-api-key': 'abc123secret', Authorization: 'Bearer abc123secret' } }, 'req');
    expect(out.all()).not.toContain('abc123secret');
  });

  it('scrubs secrets registered after the logger was created', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination });
    registerSecret('late-secret-value-42');
    log.info('using late-secret-value-42 now');
    expect(out.all()).not.toContain('late-secret-value-42');
  });

  it('uses the product name', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info('hi');
    expect(JSON.parse(out.lines[0]).name).toBe('job-scraper');
  });
});

describe('log format (final review, ops minor)', () => {
  it('writes readable lines when asked, still without secrets', () => {
    const out = capture();
    const log = createLogger({ destination: out.destination, format: 'pretty', secrets: [KEY] });
    log.info({ source: 'Remotive' }, `scan done with ${KEY}`);
    expect(out.all()).toMatch(/INFO.*scan done with \[REDACTED\]/);
    expect(out.all()).toContain('source: "Remotive"');
    expect(out.all()).not.toContain(KEY);
    expect(() => JSON.parse(out.lines[0])).toThrow();
  });

  it('writes JSON lines otherwise (for log collectors)', () => {
    const out = capture();
    createLogger({ destination: out.destination, format: 'json' }).info('hello');
    expect(JSON.parse(out.lines[0])).toMatchObject({ msg: 'hello', level: 30 });
  });
});

describe('scrub', () => {
  it('replaces every occurrence and ignores empty secrets', () => {
    expect(scrub('a KEY b KEY', ['KEY', ''])).toBe('a [REDACTED] b [REDACTED]');
  });
});
