/**
 * Tracking after applying (PRD §28–32): which applications can receive replies, what was read from the inbox, and
 * what it suggests. Observed facts ("email received") and interpretations ("likely interview") are separate events.
 */
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { InvalidTransitionError, type ApplicationService } from '../applications/service';
import { canTransition, type ApplicationStatus } from '../applications/state';
import type { Db } from '../db';
import { applications, inboxMessages, profiles, sentEmails } from '../db/schema';
import type { SettingsStore } from '../settings';
import type { Classification } from './classify';
import type { Candidate, MatchResult } from './match';

export const TRACKING_SETTINGS_KEY = 'tracking';
export const TrackingSettingsSchema = z.object({ inboxEnabled: z.boolean(), autoUpdate: z.boolean(), threshold: z.number().min(0.5).max(1) });
export type TrackingSettings = z.infer<typeof TrackingSettingsSchema>;
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = { inboxEnabled: false, autoUpdate: false, threshold: 0.85 };

const STATE_KEY = (mailbox: string) => `tracking.mailbox.${mailbox}`;
/** lastUid: every message up to here is done. stuck: a message that failed to load, retried a few times then skipped. */
const MailboxStateSchema = z.object({ uidValidity: z.string(), lastUid: z.number().int(), stuck: z.object({ uid: z.number().int(), count: z.number().int() }).nullable().optional() }).nullable();
export type MailboxState = NonNullable<z.infer<typeof MailboxStateSchema>>;
export const STATUS_KEY = 'tracking.status';
export const TrackingStatusSchema = z.object({ ok: z.boolean(), at: z.number(), message: z.string() }).nullable();

/** Statuses replies can arrive for (the application was sent). */
const OPEN: ApplicationStatus[] = ['APPLYING', 'APPLIED', 'INTERVIEW', 'OFFER'];
const LOOKBACK_DAYS = 180;
/** Never auto-move backwards: an acknowledgement doesn't undo an interview, a rejection doesn't touch an offer. */
const RANK: Partial<Record<ApplicationStatus, number>> = { APPLYING: 1, APPLIED: 1, INTERVIEW: 2, OFFER: 3 };
const SUGGESTS: Partial<Record<Classification['label'], ApplicationStatus>> = { interview: 'INTERVIEW', rejection: 'REJECTED', offer: 'OFFER' };
/**
 * Automatic updates are for the low-stakes step only: an interview, read by the model, in mail that came from the
 * employer (its domain, its ATS, or a reply to the application). Offers and rejections always wait for the user:
 * a misread one can't be undone (REJECTED is final) or matters too much to guess.
 */
const AUTO_STATUSES = new Set<ApplicationStatus>(['INTERVIEW']);
const AUTO_MATCHES = new Set<MatchResult['matchedBy']>(['thread', 'domain', 'ats+company']);

export type InboxMessageRecord = typeof inboxMessages.$inferSelect;

export function createTrackingService(deps: { db: Db; apps: ApplicationService; settings: SettingsStore; now?: () => Date }) {
  const { db, apps } = deps;
  const now = deps.now ?? (() => new Date());

  const service = {
    settings: (): TrackingSettings => deps.settings.get(TRACKING_SETTINGS_KEY, TrackingSettingsSchema, DEFAULT_TRACKING_SETTINGS),

    /** Applications that were sent recently and can receive replies. */
    candidates(): Candidate[] {
      const since = new Date(now().getTime() - LOOKBACK_DAYS * 86_400_000);
      const rows = db.select().from(applications).where(and(inArray(applications.status, OPEN), gte(applications.approvedAt, since))).all();
      if (!rows.length) return [];
      const sent = db.select({ applicationId: sentEmails.applicationId, messageId: sentEmails.messageId }).from(sentEmails).where(inArray(sentEmails.applicationId, rows.map((r) => r.id))).all();
      return rows.map((r) => ({ id: r.id, company: r.company, jobTitle: r.jobTitle, applyEmail: r.applyEmail, applicationUrl: r.applicationUrl, sourceUrl: r.sourceUrl, sentMessageIds: sent.filter((s) => s.applicationId === r.id).map((s) => s.messageId) }));
    },

    mailboxState: (mailbox: string) => deps.settings.get(STATE_KEY(mailbox), MailboxStateSchema, null),
    setMailboxState: (mailbox: string, state: MailboxState) => deps.settings.set(STATE_KEY(mailbox), state),

    /** The user's own addresses (from their profiles): mail from them is never about an application. */
    ownAddresses(): string[] {
      return db
        .select({ data: profiles.data })
        .from(profiles)
        .all()
        .map((r) => (r.data as { personal?: { email?: string | null } } | null)?.personal?.email?.trim().toLowerCase())
        .filter((e): e is string => !!e);
    },

    /** Already recorded under this Message-ID (e.g. before the mailbox was renumbered or reconnected another way). */
    seenMessageId: (messageId: string | null) => !!messageId && !!db.select({ id: inboxMessages.id }).from(inboxMessages).where(and(isNotNull(inboxMessages.messageId), eq(inboxMessages.messageId, messageId))).get(),
    setStatus: (ok: boolean, message: string) => deps.settings.set(STATUS_KEY, { ok, at: now().getTime(), message }),
    status: () => deps.settings.get(STATUS_KEY, TrackingStatusSchema, null),

    seen: (mailbox: string, uid: number) => !!db.select({ id: inboxMessages.id }).from(inboxMessages).where(and(eq(inboxMessages.mailbox, mailbox), eq(inboxMessages.uid, uid))).get(),

    /**
     * Stores a matched email: an observed "received" event, an AI interpretation event, and either an automatic
     * status change (only if enabled, confident enough, allowed and forward) or a suggestion for the user.
     */
    record(input: { mailbox: string; uid: number; messageId: string | null; from: string; subject: string; receivedAt: Date | null; text: string; match: MatchResult; classification: Classification }): InboxMessageRecord {
      const { match, classification: c } = input;
      // One transaction, decided on the current status: a change made meanwhile can't be overwritten or misrecorded.
      return db.transaction(() => {
        const app = apps.get(match.applicationId)!;
        const suggested = SUGGESTS[c.label] ?? null;
        const s = service.settings();
        const forward = suggested && (RANK[suggested] ?? 9) > (RANK[app.status] ?? 0) && app.status !== 'OFFER';
        const allowed = !!suggested && canTransition(app.status, suggested) && (forward || (suggested === 'REJECTED' && app.status !== 'OFFER'));
        let auto = allowed && s.autoUpdate && c.method === 'ai' && c.confidence >= s.threshold && AUTO_STATUSES.has(suggested!) && AUTO_MATCHES.has(match.matchedBy);
        const row = db
          .insert(inboxMessages)
          .values({
            applicationId: app.id,
            mailbox: input.mailbox,
            uid: input.uid,
            messageId: input.messageId,
            fromAddress: input.from,
            subject: input.subject,
            receivedAt: input.receivedAt,
            snippet: input.text.slice(0, 4000),
            matchedBy: match.matchedBy,
            label: c.label,
            confidence: c.confidence,
            method: c.method,
            suggestedStatus: allowed ? suggested : null,
            resolution: null,
            createdAt: now(),
          })
          .returning()
          .get();
        apps.addEvent(app.id, 'email_received', 'observed', `Email received from ${input.from}: “${input.subject}”`, { inboxMessageId: row.id, matchedBy: match.matchedBy });
        const level = c.confidence >= 0.85 ? 'high' : c.confidence >= 0.6 ? 'medium' : 'low';
        apps.addEvent(app.id, 'email_interpreted', 'ai', `${c.method === 'ai' ? 'AI interpretation' : 'Interpretation (rules)'}: ${c.label.replace('_', ' ')} (confidence ${level}). ${c.summary}`, { inboxMessageId: row.id, label: c.label, confidence: c.confidence });
        if (auto) {
          try {
            apps.transition(app.id, suggested!, { origin: 'ai', message: `Status updated from an email (${c.label.replace('_', ' ')}, confidence ${level})`, payload: { inboxMessageId: row.id } });
          } catch (err) {
            if (!(err instanceof InvalidTransitionError)) throw err;
            auto = false; // left as a suggestion
          }
        }
        if (!auto) return row;
        db.update(inboxMessages).set({ resolution: 'auto' }).where(eq(inboxMessages.id, row.id)).run();
        return { ...row, resolution: 'auto' };
      }, { behavior: 'immediate' });
    },

    messagesFor(applicationId: number): InboxMessageRecord[] {
      return db.select().from(inboxMessages).where(eq(inboxMessages.applicationId, applicationId)).orderBy(desc(inboxMessages.receivedAt), desc(inboxMessages.id)).all();
    },

    /** A suggestion still applies: not resolved, allowed now, and the status hasn't changed since the email came. */
    suggestionCurrent(m: InboxMessageRecord): boolean {
      if (!m.applicationId || !m.suggestedStatus || m.resolution) return false;
      const app = apps.get(m.applicationId);
      if (!app || !canTransition(app.status, m.suggestedStatus)) return false;
      return !apps.timeline(app.id).some((e) => e.type === 'status' && e.occurredAt > m.createdAt);
    },

    /** The user accepted a suggestion. One that no longer applies is marked obsolete instead. */
    applySuggestion(messageId: number): void {
      const m = db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId)).get();
      if (!m?.applicationId || !m.suggestedStatus || m.resolution) return;
      if (!service.suggestionCurrent(m)) {
        db.update(inboxMessages).set({ resolution: 'obsolete' }).where(eq(inboxMessages.id, m.id)).run();
        return;
      }
      apps.transition(m.applicationId, m.suggestedStatus, { origin: 'user', message: `Status set from an email you confirmed (“${m.subject ?? ''}”)`, payload: { inboxMessageId: m.id } });
      db.update(inboxMessages).set({ resolution: 'applied' }).where(eq(inboxMessages.id, m.id)).run();
    },

    dismissSuggestion(messageId: number): void {
      db.update(inboxMessages).set({ resolution: 'dismissed' }).where(eq(inboxMessages.id, messageId)).run();
    },
  };
  return service;
}

export type TrackingService = ReturnType<typeof createTrackingService>;
