import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ai } from '../ai';
import type { Db } from '../db';
import { masterCvs } from '../db/schema';
import type { Logger } from '../logging';
import { PermanentError, type Queue } from '../queue';
import { StoragePaths, type FileStore } from '../storage';
import { CV_MIME, CvTooLargeError, extractCvText, MAX_CV_BYTES, NoTextError, sniffCvType, TooManyPagesError, UnsupportedCvTypeError } from './cv-text';
import { extractProfile } from './extract';
import { applyImport, diffProfile, type ImportChange } from './import';
import { ProfileDataSchema, type ProfileData } from './model';
import type { ProfileService } from './service';

export const PROFILE_EXTRACT_TASK = 'profile.extract';
export const ExtractPayloadSchema = z.object({ masterCvId: z.number().int() });

export type MasterCvRecord = typeof masterCvs.$inferSelect;

const StoredExtractionSchema = z.object({ data: ProfileDataSchema, warnings: z.array(z.string()) });
export type StoredExtraction = z.infer<typeof StoredExtractionSchema>;

export interface PendingReview {
  cv: MasterCvRecord;
  changes: ImportChange[];
  warnings: string[];
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'cv';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
  return (cleaned || 'cv').slice(-80);
}

export type CvService = ReturnType<typeof createCvService>;

export function createCvService(deps: {
  db: Db;
  files: FileStore;
  queue: Queue;
  profiles: ProfileService;
  ai: Ai | null;
  log: Logger;
  now?: () => Date;
}) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const get = (id: number): MasterCvRecord | null => db.select().from(masterCvs).where(eq(masterCvs.id, id)).get() ?? null;
  const setStatus = (id: number, values: Partial<typeof masterCvs.$inferInsert>) =>
    db.update(masterCvs).set(values).where(eq(masterCvs.id, id)).run();
  const readExtraction = (cv: MasterCvRecord): StoredExtraction | null => {
    const r = StoredExtractionSchema.safeParse(cv.extraction);
    return r.success ? r.data : null;
  };

  const service = {
    get,

    list(profileId: number): MasterCvRecord[] {
      return db.select().from(masterCvs).where(eq(masterCvs.profileId, profileId)).orderBy(desc(masterCvs.id)).all();
    },

    /** Validates and stores the file, then queues extraction in the worker. */
    async upload(profileId: number, originalName: string, buf: Buffer): Promise<MasterCvRecord> {
      if (!deps.profiles.get(profileId)) throw new Error(`Profile ${profileId} not found`);
      if (buf.length > MAX_CV_BYTES) throw new CvTooLargeError();
      const type = sniffCvType(buf);
      if (!type) throw new UnsupportedCvTypeError();

      const row = db
        .insert(masterCvs)
        .values({ profileId, path: '', originalName: originalName.slice(0, 200), mime: CV_MIME[type], sizeBytes: buf.length, status: 'uploaded', uploadedAt: now() })
        .returning()
        .get();
      const rel = `${StoragePaths.masterCvDir(profileId)}/${row.id}-${safeFileName(originalName)}`;
      try {
        await deps.files.write(rel, buf);
      } catch (err) {
        db.delete(masterCvs).where(eq(masterCvs.id, row.id)).run();
        throw err;
      }
      setStatus(row.id, { path: rel });
      deps.queue.enqueue(PROFILE_EXTRACT_TASK, { masterCvId: row.id }, { dedupeKey: `${PROFILE_EXTRACT_TASK}:${row.id}` });
      return { ...row, path: rel };
    },

    /** Worker step: read the file, extract a profile, then apply it or hold it for review. Always ends in a terminal status. */
    async runExtraction(masterCvId: number): Promise<void> {
      const cv = get(masterCvId);
      if (!cv) throw new PermanentError(`Master CV ${masterCvId} no longer exists`);
      const profile = deps.profiles.get(cv.profileId);
      if (!profile) throw new PermanentError(`Profile ${cv.profileId} no longer exists`);
      const startedVersion = profile.updatedAt.getTime();
      setStatus(cv.id, { status: 'extracting', error: null });

      try {
        let text: string;
        try {
          text = (await extractCvText(await deps.files.read(cv.path))).text;
        } catch (err) {
          if (err instanceof NoTextError || err instanceof UnsupportedCvTypeError || err instanceof CvTooLargeError || err instanceof TooManyPagesError) throw new PermanentError(err.message);
          throw new PermanentError('This file could not be read. It may be damaged or password-protected; try exporting it again as PDF or .docx.');
        }

        const result = await extractProfile(text, deps.ai, { now: now() });
        const extraction: StoredExtraction = { data: result.data, warnings: result.warnings };
        // Decide inside one transaction: only a profile nobody has touched since we started gets filled directly.
        const applied = deps.profiles.updateDataIf(cv.profileId, result.data, (current) => {
          const alreadyApplied = db
            .select({ id: masterCvs.id })
            .from(masterCvs)
            .where(and(eq(masterCvs.profileId, cv.profileId), eq(masterCvs.status, 'applied')))
            .get();
          return !current.userEdited && !alreadyApplied && current.updatedAt.getTime() === startedVersion;
        });
        setStatus(cv.id, { status: applied ? 'applied' : 'extracted', extractedText: text, extraction, extractionMethod: result.method, error: null });
        deps.log.info({ masterCvId: cv.id, method: result.method, autoApplied: !!applied, warnings: result.warnings.length }, 'CV extracted');
      } catch (err) {
        const message = err instanceof PermanentError ? err.message : 'Extraction failed unexpectedly. It will be retried; check the logs if it keeps failing.';
        setStatus(cv.id, { status: 'failed', error: message });
        throw err;
      }
    },

    /** After a crash, CVs left "extracting" go back to the queue (called at worker start). */
    recoverInterrupted(): number {
      const stuck = db.select().from(masterCvs).where(eq(masterCvs.status, 'extracting')).all();
      for (const cv of stuck) {
        setStatus(cv.id, { status: 'uploaded' });
        deps.queue.enqueue(PROFILE_EXTRACT_TASK, { masterCvId: cv.id }, { dedupeKey: `${PROFILE_EXTRACT_TASK}:${cv.id}` });
      }
      return stuck.length;
    },

    /** The newest extracted-but-unreviewed CV of a profile, with the field changes it proposes. */
    pendingReview(profileId: number): PendingReview | null {
      const cv = db
        .select()
        .from(masterCvs)
        .where(and(eq(masterCvs.profileId, profileId), eq(masterCvs.status, 'extracted')))
        .orderBy(desc(masterCvs.id))
        .get();
      const profile = deps.profiles.get(profileId);
      const extraction = cv ? readExtraction(cv) : null;
      if (!cv || !profile || !extraction) return null;
      return { cv, changes: diffProfile(profile.data, extraction.data), warnings: extraction.warnings };
    },

    applyPending(masterCvId: number, acceptedKeys: string[]): ProfileData {
      const cv = get(masterCvId);
      const extraction = cv ? readExtraction(cv) : null;
      const profile = cv ? deps.profiles.get(cv.profileId) : null;
      if (!cv || !extraction || !profile || cv.status !== 'extracted') throw new Error('Nothing to apply for this CV');
      const merged = applyImport(profile.data, extraction.data, acceptedKeys);
      const saved = deps.profiles.updateData(cv.profileId, merged, { byUser: true });
      setStatus(cv.id, { status: 'applied' });
      return saved.data;
    },

    dismissPending(masterCvId: number): void {
      db.update(masterCvs).set({ status: 'dismissed' }).where(and(eq(masterCvs.id, masterCvId), eq(masterCvs.status, 'extracted'))).run();
    },

    async remove(masterCvId: number): Promise<void> {
      const cv = get(masterCvId);
      if (!cv) return;
      db.delete(masterCvs).where(eq(masterCvs.id, masterCvId)).run();
      if (cv.path) await deps.files.remove(cv.path);
    },
  };
  return service;
}
