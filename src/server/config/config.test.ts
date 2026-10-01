import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSecrets, ConfigError, loadConfig } from './index';

describe('loadConfig', () => {
  it('uses safe local defaults', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3000);
    expect(c.logLevel).toBe('info');
    expect(c.dataDir).toBe(path.resolve('./data'));
    expect(c.dbPath).toBe(path.join(path.resolve('./data'), 'job-scraper.db'));
    expect(c.filesDir).toBe(path.join(path.resolve('./data'), 'files'));
  });

  it('coerces PORT and resolves DATA_DIR', () => {
    const c = loadConfig({ PORT: '4000', DATA_DIR: '/tmp/js-data' });
    expect(c.port).toBe(4000);
    expect(c.dbPath).toBe('/tmp/js-data/job-scraper.db');
  });

  it('treats empty values as unset', () => {
    const c = loadConfig({ PORT: '', DATA_DIR: '', LOG_LEVEL: '' });
    expect(c.port).toBe(3000);
    expect(c.logLevel).toBe('info');
    expect(c.logFormat).toBe('pretty');
    expect(loadConfig({ LOG_FORMAT: 'json' }).logFormat).toBe('json');
  });

  it('rejects invalid values with a message naming the variable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

describe('collectSecrets', () => {
  it('collects values of secret-looking variables only', () => {
    const secrets = collectSecrets({
      OPENAI_API_KEY: 'sk-test-1234567890',
      SMTP_PASSWORD: 'hunter2hunter2',
      TELEGRAM_BOT_TOKEN: '123456:ABCDEF',
      DATA_DIR: './data',
      EMPTY_TOKEN: '',
      SHORT_SECRET: 'abc',
    });
    expect(secrets.sort()).toEqual(['123456:ABCDEF', 'hunter2hunter2', 'sk-test-1234567890']);
  });
});
