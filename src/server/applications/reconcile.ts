/**
 * No application may wait in APPLYING without a task working on it (a crash, a give-up after retries, a timeout).
 * Run at worker start and every minute, next to reconcilePreparation.
 */
import type { Queue } from '../queue';
import { BROWSER_TASK, EMAIL_TASK, type ApplicationService } from './service';

export function reconcileApplying(deps: { apps: ApplicationService; queue: Queue }): { uncertain: number; failed: number } {
  let uncertain = 0;
  let failed = 0;
  const applying = deps.apps.list({ status: 'APPLYING', pageSize: 200 }).items;
  if (!applying.length) return { uncertain, failed };
  const tasks = [...deps.queue.recent(EMAIL_TASK, 1000), ...deps.queue.recent(BROWSER_TASK, 1000)];
  for (const app of applying) {
    const mine = tasks.filter((t) => (t.payload as { applicationId?: number })?.applicationId === app.id).sort((a, b) => b.id - a.id);
    if (mine.some((t) => t.status === 'pending' || t.status === 'running')) continue;
    const lastError = mine[0]?.lastError ?? 'The application stopped unexpectedly.';
    if (app.method === 'email') {
      const latest = deps.apps.sentEmails(app.id)[0];
      if (latest?.status === 'uncertain') continue; // waiting for the user's answer
      if (latest?.status === 'sending') {
        deps.apps.updateEmail(latest.id, { status: 'uncertain', error: 'Job Scraper stopped while sending' });
        deps.apps.addEvent(app.id, 'email_uncertain', 'system', `Sending to ${latest.toAddress} was interrupted. Check your Sent folder, then confirm or send again.`);
        uncertain++;
        continue;
      }
      if (latest?.status === 'sent') {
        deps.apps.transition(app.id, 'APPLIED', { origin: 'observed', message: `Email accepted by the mail server for ${latest.toAddress}`, payload: { messageId: latest.messageId } });
        continue;
      }
      deps.apps.transition(app.id, 'APPLICATION_FAILED', { origin: 'system', message: `The application email failed: ${lastError}`, failureCode: 'EMAIL_FAILED', failureReason: lastError });
      failed++;
      continue;
    }
    // Browser: if Submit may have been clicked, the user must check; otherwise it simply failed.
    const events = deps.apps.timeline(app.id);
    const start = events.findLastIndex((e) => e.type === 'status' && (e.payload as { to?: string } | null)?.to === 'APPLYING');
    const submitted = events.slice(start + 1).some((e) => e.type === 'browser_submit_clicked');
    deps.apps.transition(app.id, 'APPLICATION_FAILED', {
      origin: 'system',
      message: submitted ? 'Job Scraper stopped after submitting the form. Check your email or the site before applying again.' : `The browser application stopped: ${lastError}`,
      failureCode: submitted ? 'NO_CONFIRMATION' : 'BROWSER_ERROR',
      failureReason: submitted ? 'Stopped after submitting; check your email or the site.' : lastError,
    });
    failed++;
  }
  return { uncertain, failed };
}
