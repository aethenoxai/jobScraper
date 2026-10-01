import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db';
import { settings as settingsTable } from '../db/schema';

export interface SettingsStore {
  get<T>(key: string, schema: z.ZodType<T>, fallback: T): T;
  /** Stores a JSON value; null removes it. */
  set(key: string, value: unknown): void;
  update<T>(key: string, schema: z.ZodType<T>, fallback: T, fn: (current: T) => T): T;
}

export function createSettings(db: Db, opts: { now?: () => Date } = {}): SettingsStore {
  const now = opts.now ?? (() => new Date());

  function read<T>(conn: Pick<Db, 'select'>, key: string, schema: z.ZodType<T>, fallback: T): T {
    const row = conn.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    if (!row) return fallback;
    const parsed = schema.safeParse(row.value);
    return parsed.success ? parsed.data : fallback;
  }

  function write(conn: Pick<Db, 'insert' | 'delete'>, key: string, value: unknown): void {
    // null means "not set": the key falls back to its default again.
    if (value === null || value === undefined) {
      conn.delete(settingsTable).where(eq(settingsTable.key, key)).run();
      return;
    }
    const updatedAt = now();
    conn
      .insert(settingsTable)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt } })
      .run();
  }

  return {
    get: (key, schema, fallback) => read(db, key, schema, fallback),
    set: (key, value) => write(db, key, value),
    update(key, schema, fallback, fn) {
      return db.transaction(
        (tx) => {
          const next = fn(read(tx, key, schema, fallback));
          write(tx, key, next);
          return next;
        },
        { behavior: 'immediate' },
      );
    },
  };
}
