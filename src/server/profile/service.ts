import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db';
import { applications, matches, notifications, profiles, queueTasks } from '../db/schema';
import { StoragePaths, type FileStore } from '../storage';
import {
  assignIds,
  DEFAULT_PREFERENCES,
  DEFAULT_SLIDER,
  emptyProfile,
  PreferencesSchema,
  ProfileDataSchema,
  salvageProfileData,
  SLIDER_MAX,
  SLIDER_MIN,
  type Preferences,
  type ProfileData,
} from './model';

export interface ProfileRecord {
  id: number;
  name: string;
  isDefault: boolean;
  data: ProfileData;
  /** Stored details that no longer fit the schema and are not shown (empty when everything was read). */
  dataIssues: string[];
  preferences: Preferences;
  sliderValue: number;
  userEdited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class ProfileValidationError extends Error {
  override name = 'ProfileValidationError';
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export class ProfileNotFoundError extends Error {
  override name = 'ProfileNotFoundError';
  constructor(id: number) {
    super(`Profile ${id} not found`);
  }
}

const ITEM_LABELS: Record<string, string> = { experience: 'Job', education: 'Education', certifications: 'Certificate', skills: 'Skill', projects: 'Project', languages: 'Language', links: 'Link' };
const FIELD_LABELS: Record<string, string> = { fullName: 'Name', salaryMin: 'Minimum salary', salaryCurrency: 'Currency', url: 'Link' };

/** "Job 1 (Engineer), start date" for experience.0.startDate: where a problem is, in the words the form uses. */
export function describeField(path: readonly PropertyKey[], value: unknown): string {
  const parts: string[] = [];
  let at: unknown = value;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = (at as Record<PropertyKey, unknown> | undefined)?.[key];
    if (typeof key === 'string' && ITEM_LABELS[key] && typeof path[i + 1] === 'number') {
      const item = (next as unknown[] | undefined)?.[path[i + 1] as number] as Record<string, unknown> | undefined;
      const name = [item?.title, item?.institution, item?.name, item?.label].find((x) => typeof x === 'string' && x.trim());
      parts.push(`${ITEM_LABELS[key]} ${(path[i + 1] as number) + 1}${name ? ` (${name})` : ''}`);
      at = item;
      i++;
      continue;
    }
    if (typeof key === 'string' && key !== 'personal' && key !== 'application') parts.push(FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').toLowerCase());
    at = next;
  }
  const text = parts.join(', ') || 'Profile';
  return text[0].toUpperCase() + text.slice(1);
}

function fail(issues: string[]): never {
  throw new ProfileValidationError(issues.slice(0, 3).join('; '), issues);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) fail(r.error.issues.map((i) => `${describeField(i.path, value)}: ${i.message}`));
  return r.data;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks only worth making on what the user typed (a CV's own text is kept as extracted). */
function userEditIssues(data: ProfileData): string[] {
  const issues: string[] = [];
  if (data.personal.email && !EMAIL.test(data.personal.email)) issues.push(`Email: "${data.personal.email}" is not an email address`);
  for (const key of ['experience', 'education'] as const) {
    data[key].forEach((item, i) => {
      // "2021" ends after "2021-03": compare a year with the end of that year.
      if (item.startDate && item.endDate && `${item.endDate}-12`.slice(0, 7) < item.startDate.slice(0, 7)) issues.push(`${describeField([key, i], data)}: ends before it starts`);
    });
  }
  return issues;
}

function toRecord(row: typeof profiles.$inferSelect): ProfileRecord {
  // Stored values were validated on write; fall back to empty values if an old row is malformed.
  const data = salvageProfileData(row.data);
  const prefs = PreferencesSchema.safeParse(row.preferences);
  return {
    ...row,
    data: data.data,
    dataIssues: data.issues,
    preferences: prefs.success ? prefs.data : DEFAULT_PREFERENCES,
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;

export function createProfileService(deps: { db: Db; files: FileStore; now?: () => Date; /** Called after any change that affects matching. */ onChanged?: (profileId: number) => void }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const row = (id: number) => db.select().from(profiles).where(eq(profiles.id, id)).get();
  const mustGet = (id: number) => {
    const r = row(id);
    if (!r) throw new ProfileNotFoundError(id);
    return r;
  };
  const cleanName = (name: string) => {
    const n = name.trim();
    if (!n) throw new ProfileValidationError('Profile name cannot be empty');
    if (n.length > 80) throw new ProfileValidationError('Profile name is too long (max 80 characters)');
    return n;
  };

  const service = {
    list(): ProfileRecord[] {
      return db.select().from(profiles).orderBy(asc(profiles.id)).all().map(toRecord);
    },

    get(id: number): ProfileRecord | null {
      const r = row(id);
      return r ? toRecord(r) : null;
    },

    getDefault(): ProfileRecord | null {
      const r = db.select().from(profiles).where(eq(profiles.isDefault, true)).get();
      return r ? toRecord(r) : null;
    },

    create(name: string, data: ProfileData = emptyProfile()): ProfileRecord {
      const n = cleanName(name);
      const valid = assignIds(parseOrThrow(ProfileDataSchema, data));
      return db.transaction(
        (tx) => {
          const hasDefault = !!tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.isDefault, true)).get();
          const t = now();
          const created = tx
            .insert(profiles)
            .values({ name: n, isDefault: !hasDefault, data: valid, preferences: DEFAULT_PREFERENCES, sliderValue: DEFAULT_SLIDER, userEdited: false, createdAt: t, updatedAt: t })
            .returning()
            .get();
          return toRecord(created);
        },
        { behavior: 'immediate' },
      );
    },

    updateData(id: number, data: unknown, opts: { byUser?: boolean } = {}): ProfileRecord {
      const current = mustGet(id);
      const valid = assignIds(parseOrThrow(ProfileDataSchema, data));
      const issues = opts.byUser ? userEditIssues(valid) : [];
      if (issues.length) fail(issues);
      const updated = db
        .update(profiles)
        .set({ data: valid, userEdited: current.userEdited || !!opts.byUser, updatedAt: now() })
        .where(eq(profiles.id, id))
        .returning()
        .get();
      deps.onChanged?.(id);
      return toRecord(updated);
    },

    /**
     * Writes `data` only if `shouldApply` (checked inside the same IMMEDIATE transaction) still agrees,
     * so a background extraction can never overwrite edits saved in the meantime. Returns null if skipped.
     */
    updateDataIf(id: number, data: unknown, shouldApply: (current: ProfileRecord) => boolean): ProfileRecord | null {
      const valid = assignIds(parseOrThrow(ProfileDataSchema, data));
      const result = db.transaction(
        (tx) => {
          const current = tx.select().from(profiles).where(eq(profiles.id, id)).get();
          if (!current || !shouldApply(toRecord(current))) return null;
          const updated = tx.update(profiles).set({ data: valid, updatedAt: now() }).where(eq(profiles.id, id)).returning().get();
          return toRecord(updated);
        },
        { behavior: 'immediate' },
      );
      if (result) deps.onChanged?.(id);
      return result;
    },

    updatePreferences(id: number, preferences: unknown, sliderValue: number): ProfileRecord {
      mustGet(id);
      const prefs = parseOrThrow(PreferencesSchema, preferences);
      if (prefs.salaryCurrency !== null) {
        if (!/^[a-z]{3}$/i.test(prefs.salaryCurrency)) fail([`Currency: use a 3-letter code such as EUR, USD or INR (not "${prefs.salaryCurrency}")`]);
        prefs.salaryCurrency = prefs.salaryCurrency.toUpperCase();
      }
      if (!Number.isInteger(sliderValue) || sliderValue < SLIDER_MIN || sliderValue > SLIDER_MAX) {
        throw new ProfileValidationError(`Matching level must be between ${SLIDER_MIN}% and ${SLIDER_MAX}%`);
      }
      const updated = db
        .update(profiles)
        .set({ preferences: prefs, sliderValue, updatedAt: now() })
        .where(eq(profiles.id, id))
        .returning()
        .get();
      deps.onChanged?.(id);
      return toRecord(updated);
    },

    rename(id: number, name: string): ProfileRecord {
      mustGet(id);
      const updated = db.update(profiles).set({ name: cleanName(name), updatedAt: now() }).where(eq(profiles.id, id)).returning().get();
      return toRecord(updated);
    },

    duplicate(id: number, name?: string): ProfileRecord {
      const src = toRecord(mustGet(id));
      const t = now();
      const created = db
        .insert(profiles)
        .values({
          name: cleanName(name ?? `${src.name} (copy)`),
          isDefault: false,
          data: src.data,
          preferences: src.preferences,
          sliderValue: src.sliderValue,
          userEdited: src.userEdited,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      deps.onChanged?.(created.id);
      return toRecord(created);
    },

    setDefault(id: number): void {
      mustGet(id);
      db.transaction(
        (tx) => {
          tx.update(profiles).set({ isDefault: false }).where(eq(profiles.isDefault, true)).run();
          tx.update(profiles).set({ isDefault: true }).where(eq(profiles.id, id)).run();
        },
        { behavior: 'immediate' },
      );
    },

    /** Deletes a profile with its CVs and its applications (rows cascade; their files are removed here). */
    async delete(id: number): Promise<void> {
      const target = mustGet(id);
      // Read inside the transaction: an approval landing meanwhile can't leave an application folder behind.
      const appIds = db.transaction(
        (tx) => {
          const ids = tx.select({ id: applications.id }).from(applications).where(eq(applications.profileId, id)).all().map((a) => a.id);
          if (ids.length) {
            // Like deleting each application (N10): its waiting work is cancelled and the email drafts kept in the
            // work queue are forgotten.
            const ofThese = and(like(queueTasks.type, 'application.%'), inArray(sql`json_extract(${queueTasks.payload}, '$.applicationId')`, ids));
            tx.update(queueTasks).set({ status: 'failed', lastError: 'Cancelled', updatedAt: now() }).where(and(ofThese, eq(queueTasks.status, 'pending'))).run();
            tx.update(queueTasks).set({ payload: sql`json_object('applicationId', json_extract(${queueTasks.payload}, '$.applicationId'), 'deleted', json('true'))` }).where(ofThese).run();
          }
          // Notifications about its matches and applications would only lead to missing pages.
          tx.delete(notifications)
            .where(
              or(
                inArray(notifications.link, tx.select({ link: sql<string>`'/feed/' || ${matches.id}` }).from(matches).where(eq(matches.profileId, id))),
                like(notifications.link, `/feed?profile=${id}&%`),
                ids.length ? inArray(notifications.link, ids.map((a) => `/applications/${a}`)) : undefined,
              ),
            )
            .run();
          tx.delete(profiles).where(eq(profiles.id, id)).run();
          if (target.isDefault) {
            const next = tx.select({ id: profiles.id }).from(profiles).orderBy(asc(profiles.id)).limit(1).get();
            if (next) tx.update(profiles).set({ isDefault: true }).where(eq(profiles.id, next.id)).run();
          }
          return ids;
        },
        { behavior: 'immediate' },
      );
      await deps.files.remove(StoragePaths.profileDir(id));
      for (const appId of appIds) await deps.files.remove(StoragePaths.applicationDir(appId));
    },
  };
  return service;
}
