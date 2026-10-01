import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createSettings } from '../settings';
import { readScraplingStatus, SCRAPLING_STATUS_KEY, statusFromHelper, writeScraplingStatus } from './status';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('scrapling status', () => {
  it('is null until the worker has checked', () => {
    expect(readScraplingStatus(createSettings(t.db))).toBeNull();
  });

  it('keeps what the worker found', () => {
    const settings = createSettings(t.db);
    writeScraplingStatus(settings, statusFromHelper({ ready: true, info: { scrapling: '0.4.15', python: '3.12.7' } }, 1000));
    expect(readScraplingStatus(settings)).toEqual({ ready: true, scrapling: '0.4.15', python: '3.12.7', error: null, checkedAt: 1000 });
    writeScraplingStatus(settings, statusFromHelper({ ready: false, code: 'NOT_INSTALLED', error: 'no venv' }, 2000));
    expect(readScraplingStatus(settings)).toEqual({ ready: false, scrapling: null, python: null, error: 'no venv', checkedAt: 2000 });
  });

  it('treats a damaged value as unknown', () => {
    const settings = createSettings(t.db);
    settings.set(SCRAPLING_STATUS_KEY, { ready: 'maybe' });
    expect(readScraplingStatus(settings)).toBeNull();
  });
});
