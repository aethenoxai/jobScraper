/** Text search helpers: what the user types is matched literally ("100%" or "c_level" are not wildcards). */
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** `column` contains `text` (case-insensitive for ASCII, as SQLite's LIKE is), with %, _ and \ taken literally. */
export function containsText(column: SQLiteColumn, text: string): SQL {
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`${column} like ${pattern} escape '\\'`;
}
