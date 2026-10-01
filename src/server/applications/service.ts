/**
 * Applications after approval (PLAN §2.5, PRD §28–31, §41): status changes along the state machine with an event
 * for each, the generated documents (one per kind), edits of the tailored CV, and deletion (N10).
 */
import { and, count, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db';
import { applicationEvents, applications, documents, DOCUMENT_KINDS, matches, APPLICATION_STATUSES, notifications, sentEmails } from '../db/schema';
import { NEVER_FETCH } from '../discovery/web';
import { hasRealLink } from '../jobs/links';
import { scrubSecrets } from '../logging';
import { PREPARE_TASK } from '../matching/service';
import type { ProfileService } from '../profile/service';
import type { Queue } from '../queue';
import { StoragePaths, type FileStore } from '../storage';
import { CoverLetterSchema, coverLetterText, validateCoverLetter, type CoverLetter, type LetterJob } from '../tailoring/cover-letter';
import { TailoredCvSchema, type TailoredCv } from '../tailoring/model';
import { EmailDraftSchema, type EmailDraft } from './email-draft';
import { TEMPLATES } from '../tailoring/render';
import { validateTailoredCv, type Violation } from '../tailoring/validate';
import { canTransition, NOTE_MAX, STATUS_LABELS, type ApplicationStatus } from './state';

/** Re-renders an application's CV (HTML + PDF) from its saved tailored CV, e.g. after an edit. */
export const RENDER_TASK = 'application.render';
/** Sends an application email the user approved (PRD §24). */
export const EMAIL_TASK = 'application.email';
/** Applies on the job's website in the browser, after the user asked (PRD §25). */
export const BROWSER_TASK = 'application.browser';

const CLOSED: ApplicationStatus[] = ['REJECTED', 'WITHDRAWN', 'EXPIRED'];

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
}
export class ApplicationNotFoundError extends Error {
  override name = 'ApplicationNotFoundError';
}

export type ApplicationRecord = typeof applications.$inferSelect;
export type DocumentRecord = typeof documents.$inferSelect;
export type EventRecord = typeof applicationEvents.$inferSelect;
export type SentEmailRecord = typeof sentEmails.$inferSelect;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
type Origin = EventRecord['origin'];

/** The stored tailored CV with how it is rendered. */
export const TailoredCvDocSchema = z.object({ cv: TailoredCvSchema, template: z.enum(TEMPLATES), repairs: z.number().int().min(0) });
export type TailoredCvDoc = z.infer<typeof TailoredCvDocSchema>;
const CV_JSON = 'tailored-cv.json';
const LETTER_JSON = 'cover-letter.json';
const EMAIL_JSON = 'email-draft.json';

export const CoverLetterDocSchema = z.object({ letter: CoverLetterSchema, repairs: z.number().int().min(0) });
export type CoverLetterDoc = z.infer<typeof CoverLetterDocSchema>;

const DAY_MS = 86_400_000;
/** The package can be changed until it is used: after applying it is the record of what was sent (PRD §65). */
const EDITABLE: ApplicationStatus[] = ['READY', 'PREPARATION_FAILED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED', 'EXPIRED'];

export function createApplicationService(deps: { db: Db; files: FileStore; queue: Queue; profiles: ProfileService; now?: () => Date }) {
  const { db, files } = deps;
  const now = deps.now ?? (() => new Date());

  /** Small JSON documents are read synchronously so server components can use them directly. */
  function readJson<T>(id: number, kind: DocumentKind, schema: z.ZodType<T>): T | null {
    const doc = db.select().from(documents).where(and(eq(documents.applicationId, id), eq(documents.kind, kind))).get();
    if (!doc) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(files.resolve(doc.path), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  const assertEditable = (app: ApplicationRecord) => {
    if (!EDITABLE.includes(app.status)) throw new InvalidTransitionError(`The documents can't be changed while the application is “${STATUS_LABELS[app.status]}”`);
  };

  /** The attachments must match the latest edits: never send a PDF that is about to be replaced. */
  const assertPdfCurrent = (id: number) => {
    if (service.renderPending(id) || service.pdfOutdated(id)) throw new InvalidTransitionError('The PDF is being updated with your latest changes; try again in a moment');
  };

  const getOrThrow = (id: number): ApplicationRecord => {
    const app = db.select().from(applications).where(eq(applications.id, id)).get();
    if (!app) throw new ApplicationNotFoundError(`Application ${id} not found`);
    return app;
  };

  function addEvent(applicationId: number, type: string, origin: Origin, message: string, payload?: unknown): void {
    db.insert(applicationEvents).values({ applicationId, type, origin, message, payload: payload ?? null, occurredAt: now() }).run();
  }

  const service = {
    get(id: number): ApplicationRecord | null {
      return db.select().from(applications).where(eq(applications.id, id)).get() ?? null;
    },

    list(opts: { status?: ApplicationStatus | ApplicationStatus[]; profileId?: number; page?: number; pageSize?: number }) {
      const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
      const page = Math.max(opts.page ?? 1, 1);
      const statuses = opts.status === undefined ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
      const where = and(statuses ? inArray(applications.status, statuses) : undefined, opts.profileId ? eq(applications.profileId, opts.profileId) : undefined);
      const total = db.select({ n: count() }).from(applications).where(where).get()?.n ?? 0;
      const items = db.select().from(applications).where(where).orderBy(desc(applications.updatedAt), desc(applications.id)).limit(pageSize).offset((page - 1) * pageSize).all();
      return { items, total, page, pageSize };
    },

    /** Applications per status (for the status tabs). */
    counts(profileId?: number): Record<ApplicationStatus, number> {
      const rows = db
        .select({ status: applications.status, n: count() })
        .from(applications)
        .where(profileId ? eq(applications.profileId, profileId) : undefined)
        .groupBy(applications.status)
        .all();
      const out = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<ApplicationStatus, number>;
      for (const r of rows) out[r.status] = r.n;
      return out;
    },

    /** Progress of what was approved in the last 24 hours (PRD §41: "27 approved: 20 ready, 5 preparing…"). */
    batchProgress(): { approved: number; preparing: number; ready: number; failed: number } {
      const rows = db
        .select({ status: applications.status, n: count() })
        .from(applications)
        .where(gte(applications.approvedAt, new Date(now().getTime() - DAY_MS)))
        .groupBy(applications.status)
        .all();
      const by = (...s: ApplicationStatus[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
      return { approved: by(...APPLICATION_STATUSES), preparing: by('PREPARING'), ready: by('READY'), failed: by('PREPARATION_FAILED') };
    },

    timeline(id: number): EventRecord[] {
      return db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, id)).orderBy(applicationEvents.occurredAt, applicationEvents.id).all();
    },

    /** Moves an application to a new status if the state machine allows it, recording why. */
    transition(id: number, to: ApplicationStatus, opts: { origin: Origin; message: string; failureCode?: string; failureReason?: string; payload?: unknown }): ApplicationRecord {
      return db.transaction(
        (tx) => {
          const app = tx.select().from(applications).where(eq(applications.id, id)).get();
          if (!app) throw new ApplicationNotFoundError(`Application ${id} not found`);
          if (!canTransition(app.status, to)) throw new InvalidTransitionError(`Can't change an application from “${STATUS_LABELS[app.status]}” to “${STATUS_LABELS[to]}”`);
          const t = now();
          const failed = to === 'PREPARATION_FAILED' || to === 'APPLICATION_FAILED' || to === 'APPLICATION_SKIPPED';
          const updated = tx
            .update(applications)
            .set({
              status: to,
              updatedAt: t,
              failureCode: failed ? (opts.failureCode ?? null) : null,
              failureReason: failed && opts.failureReason ? scrubSecrets(opts.failureReason).slice(0, 1000) : null,
              ...(to === 'APPLIED' && !app.submittedAt ? { submittedAt: t } : {}),
            })
            .where(eq(applications.id, id))
            .returning()
            .get();
          tx.insert(applicationEvents)
            .values({ applicationId: id, type: 'status', origin: opts.origin, message: scrubSecrets(opts.message), payload: { from: app.status, to, ...(opts.payload ? { details: opts.payload } : {}) }, occurredAt: t })
            .run();
          return updated;
        },
        { behavior: 'immediate' },
      );
    },

    /** The user applied themselves (outside Job Scraper). */
    markApplied(id: number, note?: string): ApplicationRecord {
      const app = service.transition(id, 'APPLIED', { origin: 'user', message: note?.trim() ? `Marked as applied: ${note.trim()}` : 'Marked as applied' });
      return db.update(applications).set({ method: 'manual' }).where(eq(applications.id, app.id)).returning().get();
    },

    /** A status change the user made (interview, offer, rejected…), within the state machine. */
    setStatus(id: number, to: ApplicationStatus, note?: string): ApplicationRecord {
      if (to === 'PREPARING' || to === 'APPLYING') throw new InvalidTransitionError('Job Scraper sets this status itself');
      if (getOrThrow(id).status === 'APPLYING') throw new InvalidTransitionError("The status can't be changed while it is being sent; wait for the result");
      return service.transition(id, to, { origin: 'user', message: note?.trim() ? `${STATUS_LABELS[to]}: ${note.trim()}` : `Marked as ${STATUS_LABELS[to].toLowerCase()}` });
    },

    addNote(id: number, text: string): void {
      getOrThrow(id);
      if (text.trim()) addEvent(id, 'note', 'user', text.trim().slice(0, NOTE_MAX));
    },

    addInterview(id: number, i: { at: Date; kind: 'phone' | 'video' | 'onsite' | 'other'; details: string | null }): void {
      const app = getOrThrow(id);
      const when = i.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
      db.transaction(() => {
        // An interview being scheduled is what "Interview" means: no need to change the status by hand as well.
        if (app.status === 'APPLIED') service.transition(id, 'INTERVIEW', { origin: 'user', message: 'Interview scheduled' });
        addEvent(id, 'interview_scheduled', 'user', `${i.kind === 'onsite' ? 'On-site' : i.kind[0].toUpperCase() + i.kind.slice(1)} interview on ${when}${i.details ? `: ${i.details}` : ''}`, { at: i.at.getTime(), kind: i.kind, details: i.details });
      }, { behavior: 'immediate' });
    },

    setOffer(id: number, o: { salary: string | null; deadline: Date | null; notes: string | null }): void {
      getOrThrow(id);
      addEvent(id, 'offer_details', 'user', ['Offer details', o.salary && `salary ${o.salary}`, o.deadline && `reply by ${o.deadline.toISOString().slice(0, 10)}`, o.notes].filter(Boolean).join(' · '), { salary: o.salary, deadline: o.deadline?.getTime() ?? null, notes: o.notes });
    },

    /** Interviews still to come, soonest first (dashboard). */
    upcomingInterviews(limit = 5): Array<{ applicationId: number; company: string; jobTitle: string; at: Date; kind: string; details: string | null }> {
      const t = now().getTime();
      const events = db.select().from(applicationEvents).where(eq(applicationEvents.type, 'interview_scheduled')).all();
      const upcoming = events
        .map((e) => ({ e, p: e.payload as { at?: number; kind?: string; details?: string | null } | null }))
        .filter(({ p }) => typeof p?.at === 'number' && p.at >= t)
        .sort((a, b) => a.p!.at! - b.p!.at!);
      return upcoming.flatMap(({ e, p }) => {
        const app = service.get(e.applicationId);
        // Interviews of closed applications (rejected, withdrawn, expired) won't happen.
        return app && !CLOSED.includes(app.status) ? [{ applicationId: app.id, company: app.company, jobTitle: app.jobTitle, at: new Date(p!.at!), kind: p!.kind ?? 'other', details: p!.details ?? null }] : [];
      }).slice(0, limit);
    },

    withdraw(id: number): ApplicationRecord {
      return service.transition(id, 'WITHDRAWN', { origin: 'user', message: 'Withdrawn' });
    },

    retryPreparation(id: number): ApplicationRecord {
      // One transaction: the worker's reconcile must never see PREPARING without its task.
      return db.transaction(() => {
        const app = service.transition(id, 'PREPARING', { origin: 'user', message: 'Preparing again' });
        deps.queue.enqueue(PREPARE_TASK, { applicationId: id }, { dedupeKey: `${PREPARE_TASK}:${id}` });
        return app;
      }, { behavior: 'immediate' });
    },

    documents(id: number): DocumentRecord[] {
      return db.select().from(documents).where(eq(documents.applicationId, id)).orderBy(documents.kind).all();
    },

    document(id: number, kind: DocumentKind): DocumentRecord | null {
      return db.select().from(documents).where(and(eq(documents.applicationId, id), eq(documents.kind, kind))).get() ?? null;
    },

    documentById(docId: number): DocumentRecord | null {
      return db.select().from(documents).where(eq(documents.id, docId)).get() ?? null;
    },

    /** Saves a generated file, replacing the previous one of the same kind (one tailored CV per application). */
    async saveDocument(id: number, kind: DocumentKind, filename: string, mime: string, data: string | Uint8Array): Promise<DocumentRecord> {
      getOrThrow(id);
      const rel = `${StoragePaths.applicationDir(id)}/${filename}`;
      const old = db.select().from(documents).where(and(eq(documents.applicationId, id), eq(documents.kind, kind))).all();
      await files.write(rel, data);
      const saved = db.transaction((tx) => {
        // The application may have been deleted while the file was written.
        if (!tx.select({ id: applications.id }).from(applications).where(eq(applications.id, id)).get()) return null;
        tx.delete(documents).where(and(eq(documents.applicationId, id), eq(documents.kind, kind))).run();
        return tx.insert(documents).values({ applicationId: id, kind, path: rel, filename, mime, createdAt: now() }).returning().get();
      }, { behavior: 'immediate' });
      if (!saved) {
        await files.remove(StoragePaths.applicationDir(id));
        throw new ApplicationNotFoundError(`Application ${id} was deleted`);
      }
      for (const o of old) if (o.path !== rel) await files.remove(o.path);
      return saved;
    },

    async readDocument(doc: DocumentRecord): Promise<Buffer> {
      return files.read(doc.path);
    },

    async saveTailoredCv(id: number, doc: TailoredCvDoc): Promise<void> {
      await service.saveDocument(id, 'tailored_cv_json', CV_JSON, 'application/json', JSON.stringify(TailoredCvDocSchema.parse(doc), null, 2));
    },

    /** The saved tailored CV (read synchronously from disk through the document record). */
    tailoredCv(id: number): TailoredCvDoc | null {
      return readJson(id, 'tailored_cv_json', TailoredCvDocSchema);
    },

    async saveCoverLetter(id: number, doc: CoverLetterDoc): Promise<void> {
      await service.saveDocument(id, 'cover_letter', LETTER_JSON, 'application/json', JSON.stringify(CoverLetterDocSchema.parse(doc), null, 2));
    },

    coverLetter(id: number): CoverLetterDoc | null {
      return readJson(id, 'cover_letter', CoverLetterDocSchema);
    },

    async saveEmailDraft(id: number, draft: EmailDraft): Promise<void> {
      await service.saveDocument(id, 'email', EMAIL_JSON, 'application/json', JSON.stringify(EmailDraftSchema.parse(draft), null, 2));
    },

    /** The application email as last drafted or edited (null if the job takes no email applications). */
    emailDraft(id: number): EmailDraft | null {
      return readJson(id, 'email', EmailDraftSchema);
    },

    /**
     * Saves the user's edit of the tailored CV if it is still grounded in the profile (N3), then queues the
     * PDF to be rendered again. Facts like employers and dates can't be edited here; they come from the profile.
     */
    async saveEditedCv(id: number, cv: TailoredCv, template?: TailoredCvDoc['template']): Promise<{ ok: boolean; violations: Violation[] }> {
      const app = getOrThrow(id);
      assertEditable(app);
      const profile = deps.profiles.get(app.profileId);
      if (!profile) throw new ApplicationNotFoundError('The profile of this application no longer exists');
      const current = service.tailoredCv(id);
      const edited: TailoredCv = { ...cv, method: 'edited' };
      const violations = validateTailoredCv(edited, profile.data);
      if (violations.length) return { ok: false, violations };
      // Edited text is the user's own and fully validated: no parts are "kept in your original wording" any more.
      await service.saveTailoredCv(id, { cv: edited, template: template ?? current?.template ?? 'classic', repairs: 0 });
      addEvent(id, 'cv_edited', 'user', 'Edited the tailored CV');
      deps.queue.enqueue(RENDER_TASK, { applicationId: id }, { dedupeKey: `${RENDER_TASK}:${id}` });
      return { ok: true, violations: [] };
    },

    /**
     * Saves the user's edit of the cover letter if it only uses profile facts (N3), refreshes an unsent email's body
     * with it and queues the PDF to be rendered again.
     */
    async saveEditedCoverLetter(id: number, letter: CoverLetter, job: LetterJob): Promise<{ ok: boolean; violations: Violation[] }> {
      const app = getOrThrow(id);
      assertEditable(app);
      const profile = deps.profiles.get(app.profileId);
      if (!profile) throw new ApplicationNotFoundError('The profile of this application no longer exists');
      const edited = CoverLetterSchema.parse({ ...letter, method: 'edited' });
      const violations = validateCoverLetter(edited, profile.data, job);
      if (violations.length) return { ok: false, violations };
      await service.saveCoverLetter(id, { letter: edited, repairs: 0 });
      const draft = service.emailDraft(id);
      if (draft) await service.saveEmailDraft(id, { ...draft, body: coverLetterText(edited, profile.data) });
      addEvent(id, 'cover_letter_edited', 'user', 'Edited the cover letter');
      deps.queue.enqueue(RENDER_TASK, { applicationId: id }, { dedupeKey: `${RENDER_TASK}:${id}` });
      return { ok: true, violations: [] };
    },

    /** Changes the CV template and re-renders. */
    async setTemplate(id: number, template: TailoredCvDoc['template']): Promise<void> {
      assertEditable(getOrThrow(id));
      const current = service.tailoredCv(id);
      if (!current) throw new ApplicationNotFoundError('This application has no tailored CV yet');
      await service.saveTailoredCv(id, { ...current, template });
      deps.queue.enqueue(RENDER_TASK, { applicationId: id }, { dedupeKey: `${RENDER_TASK}:${id}` });
    },

    addEvent,

    /**
     * The user pressed Send: saves their edited draft, marks the application as being applied to and queues the
     * email. Nothing is sent before this.
     */
    async sendEmail(id: number, draft: EmailDraft): Promise<void> {
      const parsed = EmailDraftSchema.parse(draft);
      const app = getOrThrow(id);
      if (!canTransition(app.status, 'APPLYING')) throw new InvalidTransitionError(`Can't send an application that is “${STATUS_LABELS[app.status]}”`);
      if (!service.document(id, 'tailored_cv_pdf')) throw new InvalidTransitionError('The tailored CV is not ready yet');
      assertPdfCurrent(id);
      await service.saveEmailDraft(id, parsed);
      // One transaction: the worker's reconcile must never see APPLYING without the method and the task.
      db.transaction(() => {
        service.transition(id, 'APPLYING', { origin: 'user', message: `Sending the application email to ${parsed.to}` });
        db.update(applications).set({ method: 'email' }).where(eq(applications.id, id)).run();
        deps.queue.enqueue(EMAIL_TASK, { applicationId: id, draft: parsed }, { dedupeKey: `${EMAIL_TASK}:${id}` });
      }, { behavior: 'immediate' });
    },

    /** The user pressed "Apply in browser". */
    applyInBrowser(id: number): void {
      const app = getOrThrow(id);
      if (!canTransition(app.status, 'APPLYING')) throw new InvalidTransitionError(`Can't apply to an application that is “${STATUS_LABELS[app.status]}”`);
      const url = app.applicationUrl ?? app.sourceUrl;
      if (!hasRealLink(url)) throw new InvalidTransitionError('This job was pasted without a link: apply on the employer’s site yourself, then mark it as applied');
      const host = URL.canParse(url) ? new URL(url).hostname : '';
      if (NEVER_FETCH.test(host)) throw new InvalidTransitionError(`Job Scraper doesn't automate ${host.replace(/^www\./, '')}. Apply on the site yourself, then mark the application as applied.`);
      if (!service.document(id, 'tailored_cv_pdf')) throw new InvalidTransitionError('The tailored CV is not ready yet');
      assertPdfCurrent(id);
      db.transaction(() => {
        service.transition(id, 'APPLYING', { origin: 'user', message: 'Applying on the job’s website' });
        db.update(applications).set({ method: 'browser' }).where(eq(applications.id, id)).run();
        deps.queue.enqueue(BROWSER_TASK, { applicationId: id }, { dedupeKey: `${BROWSER_TASK}:${id}` });
      }, { behavior: 'immediate' });
    },

    /** A website application that hasn't started yet (e.g. waiting for tomorrow's daily limit), and why it waits. */
    browserQueue(id: number): { waiting: boolean; reason: string | null } {
      const mine = deps.queue.recent(BROWSER_TASK, 200).filter((t) => (t.payload as { applicationId?: number })?.applicationId === id);
      const waiting = mine.some((t) => t.status === 'pending');
      if (!waiting) return { waiting, reason: null };
      const events = service.timeline(id);
      const start = events.findLastIndex((e) => e.type === 'status' && (e.payload as { to?: string } | null)?.to === 'APPLYING');
      return { waiting, reason: events.slice(start + 1).findLast((e) => e.type === 'browser_waiting')?.message ?? null };
    },

    /** Cancels a website application that is still waiting in the queue; one already running can't be stopped safely. */
    cancelBrowserApply(id: number): void {
      const app = getOrThrow(id);
      if (app.status !== 'APPLYING' || app.method !== 'browser') throw new InvalidTransitionError(`Can't cancel an application that is “${STATUS_LABELS[app.status]}”`);
      db.transaction(() => {
        const cancelled = deps.queue.cancelPending(BROWSER_TASK, (p) => (p as { applicationId?: number })?.applicationId === id);
        if (!cancelled) throw new InvalidTransitionError('The browser has already started on this application');
        service.transition(id, 'READY', { origin: 'user', message: 'Cancelled the website application before it started' });
      }, { behavior: 'immediate' });
    },

    /** Events of one type since a time, across applications (e.g. browser submissions today, for the daily cap). */
    eventsSince(type: string, since: Date): EventRecord[] {
      return db.select().from(applicationEvents).where(and(eq(applicationEvents.type, type), gte(applicationEvents.occurredAt, since))).orderBy(desc(applicationEvents.occurredAt)).all();
    },

    sentEmails(id: number): SentEmailRecord[] {
      return db.select().from(sentEmails).where(eq(sentEmails.applicationId, id)).orderBy(desc(sentEmails.createdAt), desc(sentEmails.id)).all();
    },

    /** Starts a send attempt: the row (with its Message-ID) exists before the provider is called. */
    recordEmailAttempt(values: Omit<typeof sentEmails.$inferInsert, 'status' | 'createdAt'>): SentEmailRecord {
      return db.insert(sentEmails).values({ ...values, status: 'sending', createdAt: now() }).returning().get();
    },

    updateEmail(rowId: number, set: Partial<Pick<SentEmailRecord, 'status' | 'response' | 'error' | 'sentAt'>>): void {
      db.update(sentEmails).set(set).where(eq(sentEmails.id, rowId)).run();
    },

    /** Updates an attempt only if it is still in `from` (a late result must not overwrite "uncertain"). */
    updateEmailIf(rowId: number, from: SentEmailRecord['status'], set: Partial<Pick<SentEmailRecord, 'status' | 'response' | 'error' | 'sentAt'>>): boolean {
      return db.update(sentEmails).set(set).where(and(eq(sentEmails.id, rowId), eq(sentEmails.status, from))).run().changes > 0;
    },

    /** After an interrupted send: the user checked their Sent folder. */
    async resolveUncertainEmail(id: number, outcome: 'was-sent' | 'send-again'): Promise<void> {
      const row = service.sentEmails(id).find((e) => e.status === 'uncertain');
      if (!row) throw new InvalidTransitionError('There is no email waiting for your confirmation');
      // Each outcome is one transaction, so the worker's reconcile never sees it half done.
      db.transaction(() => {
        if (outcome === 'was-sent') {
          service.updateEmail(row.id, { status: 'sent', sentAt: row.sentAt ?? now() });
          service.transition(id, 'APPLIED', { origin: 'user', message: `You confirmed the email to ${row.toAddress} was sent`, payload: { messageId: row.messageId } });
          return;
        }
        service.updateEmail(row.id, { status: 'failed', error: 'You chose to send again' });
        deps.queue.enqueue(EMAIL_TASK, { applicationId: id }, { dedupeKey: `${EMAIL_TASK}:${id}` });
      }, { behavior: 'immediate' });
    },

    /** Whether the CV, template and cover letter may still be changed. */
    canEdit(id: number): boolean {
      const app = service.get(id);
      return !!app && EDITABLE.includes(app.status);
    },

    /** The saved CV or letter is newer than its PDF and no render is on the way (e.g. a render failed). */
    pdfOutdated(id: number): boolean {
      const newer = (a: DocumentKind, b: DocumentKind) => {
        const src = service.document(id, a);
        const out = service.document(id, b);
        return !!src && (!out || src.createdAt.getTime() > out.createdAt.getTime());
      };
      return (newer('tailored_cv_json', 'tailored_cv_pdf') || newer('cover_letter', 'cover_letter_pdf')) && !service.renderPending(id);
    },

    /** Queues the PDFs to be rendered again (e.g. after a failed render). */
    rerender(id: number): void {
      getOrThrow(id);
      deps.queue.enqueue(RENDER_TASK, { applicationId: id }, { dedupeKey: `${RENDER_TASK}:${id}` });
    },

    /** Whether the CV is waiting to be rendered again (after an edit or template change). */
    renderPending(id: number): boolean {
      return deps.queue.recent(RENDER_TASK, 50).some((t) => (t.status === 'pending' || t.status === 'running') && (t.payload as { applicationId?: number })?.applicationId === id);
    },

    /**
     * Deletes an application with all its documents, events and files (N10). The profile and master CV are never
     * touched; the job goes back to "viewed" so it can be approved again.
     */
    async remove(id: number): Promise<void> {
      const app = getOrThrow(id);
      db.transaction((tx) => {
        tx.delete(applications).where(eq(applications.id, id)).run();
        // Notifications about it (sent or waiting) would only lead to a missing page.
        tx.delete(notifications).where(eq(notifications.link, `/applications/${id}`)).run();
        if (app.matchId) {
          const others = tx.select({ id: applications.id }).from(applications).where(and(eq(applications.matchId, app.matchId), ne(applications.id, id))).all();
          if (!others.length) tx.update(matches).set({ reviewState: 'VIEWED' }).where(and(eq(matches.id, app.matchId), eq(matches.reviewState, 'APPROVED'))).run();
        }
        // In the same transaction (a crash can't leave them behind): its waiting work is cancelled, and the email
        // draft kept in the work queue (recipient, subject, letter) is forgotten with the application.
        const mine = (p: unknown) => (p as { applicationId?: number })?.applicationId === id;
        for (const type of [PREPARE_TASK, RENDER_TASK, EMAIL_TASK, BROWSER_TASK]) deps.queue.cancelPending(type, mine);
        deps.queue.replacePayloads(EMAIL_TASK, mine, { applicationId: id, deleted: true });
      }, { behavior: 'immediate' });
      await files.remove(StoragePaths.applicationDir(id));
    },
  };
  return service;
}

export type ApplicationService = ReturnType<typeof createApplicationService>;
