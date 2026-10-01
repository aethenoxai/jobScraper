import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { createSettings } from './index';

const Prefs = z.object({ intervalMinutes: z.number().int() });
const DEFAULT = { intervalMinutes: 30 };

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('settings', () => {
  it('returns the fallback when a key is missing', () => {
    expect(createSettings(t.db).get('prefs', Prefs, DEFAULT)).toEqual(DEFAULT);
  });

  it('round-trips JSON values', () => {
    const s = createSettings(t.db);
    s.set('prefs', { intervalMinutes: 60 });
    expect(s.get('prefs', Prefs, DEFAULT)).toEqual({ intervalMinutes: 60 });
  });

  it('returns the fallback when the stored value no longer matches the schema', () => {
    const s = createSettings(t.db);
    s.set('prefs', { intervalMinutes: 'soon' });
    expect(s.get('prefs', Prefs, DEFAULT)).toEqual(DEFAULT);
  });

  it('update applies the function to the current value and persists it', () => {
    const s = createSettings(t.db);
    s.set('prefs', { intervalMinutes: 15 });
    const next = s.update('prefs', Prefs, DEFAULT, (cur) => ({ intervalMinutes: cur.intervalMinutes * 2 }));
    expect(next).toEqual({ intervalMinutes: 30 });
    expect(s.get('prefs', Prefs, DEFAULT)).toEqual({ intervalMinutes: 30 });
  });

  it('holds a write lock while the update function runs', () => {
    const s = createSettings(t.db);
    const other = new Database(t.file);
    other.pragma('busy_timeout = 0');
    s.update('prefs', Prefs, DEFAULT, (cur) => {
      expect(() =>
        other.prepare("insert into settings (key, value, updated_at) values ('x', '1', 0)").run(),
      ).toThrow(/locked|busy/i);
      return cur;
    });
    other.close();
  });

  it('setting null removes the value', () => {
    const s = createSettings(t.db);
    s.set('k', { a: 1 });
    s.set('k', null);
    expect(s.get('k', z.object({ a: z.number() }).nullable(), null)).toBeNull();
  });
});
