import path from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const EnvSchema = z.object({
  DATA_DIR: z.string().min(1).default('./data'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** pretty: readable lines (the default); json: one JSON object per line, for log collectors. */
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
});

export interface Config {
  dataDir: string;
  dbPath: string;
  filesDir: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  logFormat: 'pretty' | 'json';
  /** Values of secret env vars, used to scrub logs. Never log this array. */
  secrets: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD)$/i;
const MIN_SECRET_LENGTH = 6;

export function collectSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const nonEmpty = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(nonEmpty);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration in .env — ${problems}`);
  }
  const dataDir = path.resolve(parsed.data.DATA_DIR);
  return {
    dataDir,
    dbPath: path.join(dataDir, 'job-scraper.db'),
    filesDir: path.join(dataDir, 'files'),
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    logFormat: parsed.data.LOG_FORMAT,
    secrets: collectSecrets(env),
  };
}
