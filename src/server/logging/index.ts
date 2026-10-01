import { prettyFactory } from 'pino-pretty';
import pino from 'pino';

export type Logger = pino.Logger;

const SENSITIVE = ['apiKey', 'password', 'token', 'secret', 'authorization', 'Authorization', 'cookie', 'accessToken', 'refreshToken', '"x-api-key"'];
const bracket = (k: string) => (k.startsWith('"') ? `[${k}]` : `.${k}`);
export const REDACT_PATHS = [
  ...SENSITIVE.map((k) => (k.startsWith('"') ? `[${k}]` : k)),
  ...SENSITIVE.map((k) => `*${bracket(k)}`),
  ...SENSITIVE.map((k) => `headers${bracket(k)}`),
  ...SENSITIVE.map((k) => `*.headers${bracket(k)}`),
];

/** Secret values known at runtime (API keys, tokens, passwords). Every log line is scrubbed of them. */
const registry = new Set<string>();
const MIN_SECRET_LENGTH = 6;

/** Adds a secret value that must never appear in logs (e.g. a key loaded after startup). */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) registry.add(value);
}

export function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
    // Also catch the value as it appears inside JSON strings (quotes/backslashes escaped).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join('[REDACTED]');
  }
  return out;
}

/** Removes every registered secret from a string that will be shown or stored (errors, warnings). */
export function scrubSecrets(text: string): string {
  return scrub(text, registry);
}

export interface LoggerOptions {
  level?: string;
  name?: string;
  secrets?: readonly string[];
  destination?: { write(msg: string): void };
  /** json (default): one JSON object per line; pretty: readable lines for people reading a terminal or `docker compose logs`. */
  format?: 'json' | 'pretty';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  for (const s of opts.secrets ?? []) registerSecret(s);
  const target = opts.destination ?? pino.destination({ dest: 1, sync: true });
  // Formatted synchronously (not as a transport stream), so the last lines before a crash are never lost.
  const format = opts.format === 'pretty' ? prettyFactory({ colorize: false, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname' }) : null;
  // Scrub the final serialized line, so messages, error properties, nested values and
  // child-logger bindings are all covered in one place.
  const scrubbing = { write: (line: string) => target.write(format ? format(scrub(line, registry)) : scrub(line, registry)) };
  return pino(
    {
      name: opts.name ?? 'job-scraper',
      level: opts.level ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    scrubbing as pino.DestinationStream,
  );
}
