import { asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MANUAL_SOURCE_NAME } from '../jobs/links';
import type { Db } from '../db';
import { jobListings, jobs, sourceRuns, sources } from '../db/schema';
import type { SettingsStore } from '../settings';
import { getAdapter, listAdapters } from './registry';

export type SourceRecord = typeof sources.$inferSelect;
export type SourceRunRecord = typeof sourceRuns.$inferSelect;

const SEEDED_KEY = 'sources.seededDefaults';
const DELETED_KEY = 'sources.deletedBoards';
const Seeded = z.array(z.string());
/** Web discovery may add at most this many company boards in total. */
export const MAX_DISCOVERED_SOURCES = 100;

/** "greenhouse:gitlab" — one company board, however its config is written. */
export function sourceIdentity(adapterId: string, config: unknown): string {
  const key = getAdapter(adapterId)?.identityKey;
  const cfg = (config ?? {}) as Record<string, unknown>;
  return key && cfg[key] ? `${adapterId}:${String(cfg[key]).trim().toLowerCase()}` : `${adapterId}:${JSON.stringify(cfg)}`;
}

export class SourceConfigError extends Error {
  override name = 'SourceConfigError';
}

export type SourceService = ReturnType<typeof createSourceService>;

export function createSourceService(deps: { db: Db; settings: SettingsStore; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function validate(adapterId: string, config: unknown): Record<string, unknown> {
    const adapter = getAdapter(adapterId);
    if (!adapter) throw new SourceConfigError(`Unknown source type "${adapterId}"`);
    const r = adapter.configSchema.safeParse(config);
    if (!r.success) {
      // Named by the label the form shows ("Board name"), not the internal key ("board").
      const label = (key: PropertyKey | undefined) => adapter.configFields.find((f) => f.key === key)?.label ?? (key === undefined ? 'Settings' : String(key));
      throw new SourceConfigError(r.error.issues.map((i) => `${label(i.path[0])}: ${i.message}`).join('; '));
    }
    return r.data as Record<string, unknown>;
  }

  const service = {
    list(): SourceRecord[] {
      return db.select().from(sources).orderBy(asc(sources.id)).all();
    },

    get(id: number): SourceRecord | null {
      return db.select().from(sources).where(eq(sources.id, id)).get() ?? null;
    },

    create(adapterId: string, name: string, config: unknown, origin: SourceRecord['origin'] = 'user', enabled = true): SourceRecord {
      const valid = validate(adapterId, config);
      const n = name.trim() || getAdapter(adapterId)!.displayName;
      return db.insert(sources).values({ adapterId, name: n, config: valid, origin, enabled, createdAt: now() }).returning().get();
    },

    update(id: number, patch: { name?: string; enabled?: boolean; config?: unknown }): SourceRecord {
      const current = service.get(id);
      if (!current) throw new SourceConfigError(`Source ${id} not found`);
      const values: Partial<typeof sources.$inferInsert> = {};
      if (patch.name !== undefined) values.name = patch.name.trim() || current.name;
      if (patch.enabled !== undefined) values.enabled = patch.enabled;
      if (patch.config !== undefined) values.config = validate(current.adapterId, patch.config);
      return db.update(sources).set(values).where(eq(sources.id, id)).returning().get();
    },

    /** Deletes a source with its listings; canonical jobs left without any listing are removed too. */
    remove(id: number): void {
      const source = service.get(id);
      if (source && getAdapter(source.adapterId)?.identityKey) {
        // Remember deleted company boards so web discovery never re-adds them.
        const deleted = new Set(deps.settings.get(DELETED_KEY, Seeded, []));
        deleted.add(sourceIdentity(source.adapterId, source.config));
        deps.settings.set(DELETED_KEY, [...deleted]);
      }
      db.transaction(
        (tx) => {
          tx.delete(sources).where(eq(sources.id, id)).run();
          const withListings = tx.select({ id: jobListings.jobId }).from(jobListings);
          tx.delete(jobs).where(notInArray(jobs.id, withListings)).run();
        },
        { behavior: 'immediate' },
      );
    },

    /** Creates each adapter's default instances the first time only (a deleted default stays deleted). */
    ensureDefaults(): number {
      const seeded = new Set(deps.settings.get(SEEDED_KEY, Seeded, []));
      let created = 0;
      for (const adapter of listAdapters()) {
        for (const inst of adapter.defaultInstances ?? []) {
          const key = `${adapter.id}:${inst.name}`;
          if (seeded.has(key)) continue;
          service.create(adapter.id, inst.name, inst.config, 'default', inst.enabled);
          seeded.add(key);
          created++;
        }
      }
      deps.settings.set(SEEDED_KEY, [...seeded]);
      return created;
    },

    /** Adds a company board found by web discovery, unless it is already configured, was deleted, or the cap is reached. */
    registerDiscovered(adapterId: string, name: string, config: Record<string, unknown>): SourceRecord | null {
      const valid = validate(adapterId, config);
      const identity = sourceIdentity(adapterId, valid);
      if (new Set(deps.settings.get(DELETED_KEY, Seeded, [])).has(identity)) return null;
      const all = service.list();
      if (all.some((s) => sourceIdentity(s.adapterId, s.config) === identity)) return null;
      if (all.filter((s) => s.origin === 'discovered').length >= MAX_DISCOVERED_SOURCES) return null;
      return service.create(adapterId, name, valid, 'discovered', true);
    },

    /** The configured source for a board, if any (matched by identity, not exact config). */
    findByIdentity(adapterId: string, config: unknown): SourceRecord | null {
      const identity = sourceIdentity(adapterId, config);
      return service.list().find((s) => sourceIdentity(s.adapterId, s.config) === identity) ?? null;
    },

    /** The internal source that holds jobs added by URL or pasted by hand. */
    ensureManualSource(): SourceRecord {
      const existing = db.select().from(sources).where(eq(sources.adapterId, 'manual')).get();
      if (existing) return existing;
      return db.insert(sources).values({ adapterId: 'manual', name: MANUAL_SOURCE_NAME, config: {}, origin: 'default', enabled: false, createdAt: now() }).returning().get();
    },

    recentRuns(sourceId: number, limit = 10): SourceRunRecord[] {
      return db.select().from(sourceRuns).where(eq(sourceRuns.sourceId, sourceId)).orderBy(desc(sourceRuns.startedAt), desc(sourceRuns.id)).limit(limit).all();
    },

    listingCounts(): Map<number, number> {
      const rows = db
        .select({ sourceId: jobListings.sourceId, n: sql<number>`count(*)` })
        .from(jobListings)
        .where(eq(jobListings.status, 'active'))
        .groupBy(jobListings.sourceId)
        .all();
      return new Map(rows.map((r) => [r.sourceId, Number(r.n)]));
    },
  };
  return service;
}
