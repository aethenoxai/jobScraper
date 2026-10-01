import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../tests/helpers/temp-db';
import { registerSecret } from './logging';
import { createSettings } from './settings';
import { createFailureLog, describeFailure, PRD_FAILURE_CODES } from './failures';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('failure codes (PRD §51)', () => {
  it('every PRD code, and every more specific code Job Scraper records, has an explanation and a next step', () => {
    const internal = ['SOURCE_CONFIG', 'SOURCE_PARSE', 'SOURCE_BLOCKED', 'SOURCE_RATE_LIMITED', 'LOGIN_REQUIRED', 'BROWSER_ERROR', 'NO_CONFIRMATION'];
    for (const code of [...PRD_FAILURE_CODES, ...internal]) {
      const d = describeFailure(code);
      expect(d.code, code).toBe(code);
      expect(PRD_FAILURE_CODES, code).toContain(d.prd);
      expect(d.title.length, code).toBeGreaterThan(5);
      expect(d.help, code).toMatch(/\w.*\./);
    }
    expect(describeFailure('NO_CONFIRMATION').prd).toBe('BROWSER_APPLICATION_FAILED');
    expect(describeFailure('SOURCE_PARSE').prd).toBe('JOB_PARSE_FAILED');
    expect(describeFailure('SOMETHING_NEW')).toMatchObject({ code: 'SOMETHING_NEW', title: expect.any(String) });
  });

  it('keeps a short log of recent problems, newest first, without secrets', () => {
    const settings = createSettings(t.db);
    let clock = 1_000;
    const log = createFailureLog(settings, () => new Date(clock));
    registerSecret('sk-very-secret-key');
    log.record('MATCHING_FAILED', 'AI call failed with key sk-very-secret-key', 'Backend Engineer at Acme');
    clock = 2_000;
    log.record('JOB_DISCOVERY_FAILED', 'All 3 sources failed');
    expect(log.recent()).toEqual([
      { code: 'JOB_DISCOVERY_FAILED', message: 'All 3 sources failed', context: null, at: 2_000 },
      { code: 'MATCHING_FAILED', message: expect.not.stringContaining('sk-very-secret-key'), context: 'Backend Engineer at Acme', at: 1_000 },
    ]);
    for (let i = 0; i < 80; i++) log.record('MATCHING_FAILED', `job ${i}`);
    expect(log.recent()).toHaveLength(50);
    expect(log.recent()[0].message).toBe('job 79');
  });
});
