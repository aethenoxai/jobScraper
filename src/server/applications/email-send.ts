/**
 * Sends an application email the user approved (PRD §24) — idempotently. Each attempt is recorded with its
 * Message-ID before the provider is called. If an attempt might have reached the server (a crash or a broken
 * connection after the message was handed over), it is marked "uncertain" and never resent automatically: the user
 * checks their Sent folder and decides (N8: APPLIED only on evidence or the user's word).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EmailDraftSchema } from './email-draft';
import type { Mailer } from '../email/mailer';
import type { Logger } from '../logging';
import type { Notifier } from '../notifications/dispatcher';
import { PermanentError } from '../queue';
import { isShutdown, type TaskHandler } from '../queue/runner';
import { scrubSecrets } from '../logging';
import type { ApplicationRecord, ApplicationService, SentEmailRecord } from './service';

export { EMAIL_TASK } from './service';

/** draft: the email exactly as the user confirmed it (later edits in another tab don't change what is sent). */
const Payload = z.object({ applicationId: z.number().int(), draft: EmailDraftSchema.optional() });
/** "Name <a@b.example>" → "a@b.example". */
const bareAddress = (from: string) => from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();
const MAX_ATTEMPTS = 3;
/**
 * Whether a send failure proves the message was not accepted, so trying again can't duplicate it. Only failures
 * that happen before the message is handed over, or explicit refusals by the server, qualify. Everything else
 * (a socket error, close or timeout at any later point) may come after the server already took the message.
 * Error shapes are nodemailer's (smtp-connection): socket problems are all tagged command "CONN", so the stage
 * has to be read from the error itself.
 */
export function certainlyNotSent(err: unknown): boolean {
  if (err instanceof PermanentError) return true; // sign-in or recipient refused (classified by the mailer)
  const e = err as { code?: string; responseCode?: number; syscall?: string; message?: string };
  if (typeof e?.responseCode === 'number') return true; // the server answered, and the answer was "no"
  if (['EDNS', 'EAUTH', 'EENVELOPE', 'ETLS', 'EREQUIRETLS', 'EMESSAGE'].includes(e?.code ?? '')) return true;
  if (e?.code === 'ESOCKET' && e.syscall === 'connect') return true; // never connected
  if (e?.code === 'ETIMEDOUT' && /^(?:Connection timeout|Greeting never received)/.test(e.message ?? '')) return true;
  return false;
}

export function createEmailSendHandler(deps: { apps: ApplicationService; mailer: Mailer; notifier: Notifier; log: Logger }): TaskHandler {
  const { apps } = deps;

  function failed(app: ApplicationRecord, reason: string) {
    apps.transition(app.id, 'APPLICATION_FAILED', { origin: 'system', message: `The application email failed: ${reason}`, failureCode: 'EMAIL_FAILED', failureReason: reason });
    deps.notifier.notify('application.failed', `application:${app.id}:email:${Date.now()}`, { title: `Email not sent: ${app.jobTitle} at ${app.company}`, body: reason, link: `/applications/${app.id}` });
  }

  return async (payload, ctx) => {
    const parsed = Payload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid application.email payload');
    const app = apps.get(parsed.data.applicationId);
    if (!app || app.status !== 'APPLYING') return;

    const previous = apps.sentEmails(app.id)[0];
    if (previous?.status === 'sent') {
      // Sent, but the status change didn't happen before an interruption.
      apps.transition(app.id, 'APPLIED', { origin: 'observed', message: `Email accepted by the mail server for ${previous.toAddress}`, payload: { messageId: previous.messageId } });
      return;
    }
    if (previous?.status === 'sending' || previous?.status === 'uncertain') {
      if (previous.status === 'sending') {
        apps.updateEmail(previous.id, { status: 'uncertain', error: 'Job Scraper was interrupted while sending' });
        apps.addEvent(app.id, 'email_uncertain', 'system', `Sending to ${previous.toAddress} was interrupted. Check your Sent folder, then confirm or send again.`);
        deps.notifier.notify('application.failed', `application:${app.id}:uncertain:${previous.id}`, { title: `Check your Sent folder: ${app.jobTitle} at ${app.company}`, body: 'Sending was interrupted, so Job Scraper does not know whether it went out.', link: `/applications/${app.id}` });
      }
      return;
    }

    let row: SentEmailRecord | null = null;
    let draftTo = '';
    try {
      const draft = parsed.data.draft ?? apps.emailDraft(app.id);
      const cv = apps.document(app.id, 'tailored_cv_pdf');
      if (!draft || !cv) return failed(app, !draft ? 'The email draft is missing.' : 'The tailored CV PDF is missing.');
      draftTo = draft.to;
      const docs = [cv, ...(draft.attachCoverLetter ? [apps.document(app.id, 'cover_letter_pdf')].filter((d) => !!d) : [])];
      const attachments = await Promise.all(docs.map(async (d) => ({ filename: d.filename, content: await apps.readDocument(d), contentType: d.mime })));
      const status = deps.mailer.status();
      if (!status.ok) return failed(app, status.reason ?? 'Email is not set up.');
      const from = bareAddress(status.from!);
      const messageId = `<${randomUUID()}@${from.split('@')[1] || 'job-scraper.local'}>`;
      row = apps.recordEmailAttempt({ applicationId: app.id, messageId, provider: status.provider, fromAddress: from, toAddress: draft.to, subject: draft.subject, body: draft.body, attachments: docs.map((d) => d.id) });
      const attempt = row;
      // A task that times out mid-send can't know whether the message went out.
      const onAbort = () => {
        if (!isShutdown(ctx.signal.reason) && apps.updateEmailIf(attempt.id, 'sending', { status: 'uncertain', error: 'The send took too long to confirm' })) {
          apps.addEvent(app.id, 'email_uncertain', 'system', `Sending to ${draft.to} took too long to confirm. Check your Sent folder, then confirm or send again.`);
        }
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      let r;
      try {
        r = await deps.mailer.send({ to: draft.to, subject: draft.subject, text: draft.body, attachments, messageId });
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
      const accepted = r.accepted.map((a) => a.toLowerCase());
      if (!accepted.includes(draft.to.toLowerCase())) {
        // The server replied, but not with an acceptance of this recipient: don't claim it was applied.
        apps.updateEmail(row.id, { status: 'uncertain', error: `The server did not confirm the recipient (${r.response || 'no reply'})` });
        apps.addEvent(app.id, 'email_uncertain', 'system', `The mail server didn't confirm ${draft.to}. Check your Sent folder, then confirm or send again.`);
        return;
      }
      apps.updateEmail(row.id, { status: 'sent', response: r.response || null, sentAt: new Date() });
      apps.transition(app.id, 'APPLIED', {
        origin: 'observed',
        message: `Email accepted by the mail server for ${draft.to}${r.response ? ` (${r.response})` : ''}`,
        payload: { messageId, sentEmailId: row.id, accepted: r.accepted, rejected: r.rejected },
      });
      deps.notifier.notify('application.applied', `application:${app.id}:applied`, { title: `Applied: ${app.jobTitle} at ${app.company}`, body: `Your application email was sent to ${draft.to}.`, link: `/applications/${app.id}` });
    } catch (err) {
      if (ctx.signal.aborted && isShutdown(ctx.signal.reason) && !row) throw err;
      const message = scrubSecrets(err instanceof Error ? err.message : String(err));
      if (row && !certainlyNotSent(err)) {
        // It may have reached the server: never risk a second application email.
        if (apps.updateEmailIf(row.id, 'sending', { status: 'uncertain', error: message })) {
          apps.addEvent(app.id, 'email_uncertain', 'system', `Sending to ${draftTo} broke off (${message}). Check your Sent folder, then confirm or send again.`);
          deps.notifier.notify('application.failed', `application:${app.id}:uncertain:${row.id}`, { title: `Check your Sent folder: ${app.jobTitle} at ${app.company}`, body: message, link: `/applications/${app.id}` });
        }
        return;
      }
      if (row) apps.updateEmailIf(row.id, 'sending', { status: 'failed', error: message });
      if (err instanceof PermanentError || ctx.attempt >= MAX_ATTEMPTS) {
        deps.log.warn({ applicationId: app.id, error: message }, 'application email failed');
        return failed(app, message);
      }
      throw err;
    }
  };
}
