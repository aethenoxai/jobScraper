/**
 * Worker tasks that build an application package after approval (PRD §20–22): a tailored CV grounded in the
 * profile, its HTML and PDF, and a change report. Runs only in the worker (it needs Chromium for the PDF).
 */
import { z } from 'zod';
import type { Ai } from '../ai';
import type { Logger } from '../logging';
import type { MatchService } from '../matching/service';
import { interpretSlider } from '../matching/slider';
import type { Notifier } from '../notifications/dispatcher';
import type { ProfileData } from '../profile/model';
import type { ProfileService } from '../profile/service';
import { PermanentError, RetryLaterError } from '../queue';
import { isShutdown, type TaskHandler } from '../queue/runner';
import type { Queue } from '../queue';
import { PREPARE_TASK } from '../matching/service';
import { tailorCv } from '../tailoring/ai';
import { writeCoverLetter } from '../tailoring/cover-letter';
import { cvFilename, renderCoverLetterHtml, renderCvHtml, type PdfRenderer } from '../tailoring/render';
import { buildEmailDraft } from './email-draft';
import { buildChangeReport } from '../tailoring/report';
import type { ApplicationRecord, ApplicationService, TailoredCvDoc } from './service';

const Payload = z.object({ applicationId: z.number().int() });
/** Matches the queue's default number of attempts. */
const MAX_ATTEMPTS = 3;

export interface PrepareDeps {
  apps: ApplicationService;
  profiles: ProfileService;
  matching: MatchService;
  ai: Ai | null;
  pdf: PdfRenderer;
  notifier: Notifier;
  log: Logger;
}

/** Playwright without its browser is a setup problem, not something a retry fixes. */
function classify(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(message)) {
    return new PermanentError('PDF rendering needs Chromium. Run `pnpm exec playwright install chromium` and then retry.');
  }
  return err instanceof Error ? err : new Error(message);
}

/** Writes the CV's HTML, PDF and change report, and the cover letter PDF, from the saved documents. */
async function renderDocuments(deps: PrepareDeps, app: ApplicationRecord, profile: ProfileData, doc: TailoredCvDoc): Promise<void> {
  const html = renderCvHtml(profile, doc.cv, doc.template);
  const pdf = await deps.pdf.render(html);
  const pdfName = cvFilename(app.company, app.jobTitle);
  await deps.apps.saveDocument(app.id, 'tailored_cv_html', pdfName.replace(/\.pdf$/, '.html'), 'text/html', html);
  await deps.apps.saveDocument(app.id, 'tailored_cv_pdf', pdfName, 'application/pdf', pdf);
  await deps.apps.saveDocument(app.id, 'change_report', 'change-report.json', 'application/json', JSON.stringify(buildChangeReport(profile, doc.cv, doc.repairs), null, 2));
  const letter = deps.apps.coverLetter(app.id);
  if (letter) {
    const letterPdf = await deps.pdf.render(renderCoverLetterHtml(profile, letter.letter, new Date(), doc.template));
    await deps.apps.saveDocument(app.id, 'cover_letter_pdf', cvFilename(app.company, app.jobTitle, 'Cover_Letter'), 'application/pdf', letterPdf);
  }
}

function fail(deps: PrepareDeps, app: ApplicationRecord, reason: string): void {
  deps.apps.transition(app.id, 'PREPARATION_FAILED', { origin: 'system', message: `Couldn't prepare the application: ${reason}`, failureCode: 'CV_GENERATION_FAILED', failureReason: reason });
  deps.notifier.notify('application.failed', `application:${app.id}:prepare:${Date.now()}`, {
    title: `Couldn't prepare: ${app.jobTitle} at ${app.company}`,
    body: reason,
    link: `/applications/${app.id}`,
  });
}

export function createPrepareHandler(deps: PrepareDeps): TaskHandler {
  return async (payload, ctx) => {
    const parsed = Payload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid application.prepare payload');
    const app = deps.apps.get(parsed.data.applicationId);
    // Withdrawn, deleted or already prepared meanwhile: nothing to do.
    if (!app || app.status !== 'PREPARING') return;
    try {
      const profile = deps.profiles.get(app.profileId);
      if (!profile) throw new PermanentError('The profile of this application was deleted.');
      const analysis = app.jobId ? await deps.matching.analysisFor(app.jobId, ctx.signal) : null;
      if (!analysis) throw new PermanentError('The job of this application was removed, so there is nothing to tailor the CV to.');
      const intensity = interpretSlider(profile.sliderValue).tailoringIntensity;
      // Withdrawn or deleted while a step ran: stop before the next (AI) step instead of spending on it.
      const stillWanted = () => deps.apps.get(app.id)?.status === 'PREPARING';
      const { cv, repairs, aiError } = await tailorCv({ profile: profile.data, analysis, intensity, job: { title: app.jobTitle, company: app.company }, ai: deps.ai, signal: ctx.signal });
      if (!stillWanted()) return;
      if (aiError) deps.apps.addEvent(app.id, 'ai_fallback', 'system', `AI tailoring wasn't available (${aiError}), so your CV was reordered without rewording.`);
      const doc: TailoredCvDoc = { cv, template: 'classic', repairs };
      await deps.apps.saveTailoredCv(app.id, doc);
      const job = { title: app.jobTitle, company: app.company, description: app.jobId ? deps.matching.descriptionFor(app.jobId) : '' };
      const cover = await writeCoverLetter({ profile: profile.data, analysis, job, ai: deps.ai, signal: ctx.signal });
      if (!stillWanted()) return;
      await deps.apps.saveCoverLetter(app.id, { letter: cover.letter, repairs: cover.repairs });
      if (cover.aiError) deps.apps.addEvent(app.id, 'ai_fallback', 'system', `AI wasn't available for the cover letter (${cover.aiError}), so it was written from your profile's own lines.`);
      const draft = buildEmailDraft(app, profile.data, cover.letter);
      if (draft) await deps.apps.saveEmailDraft(app.id, draft);
      await renderDocuments(deps, app, profile.data, doc);

      if (!stillWanted()) return; // withdrawn while we worked
      const how = `${cv.method === 'ai' ? `AI, ${intensity} tailoring` : 'offline: reordered, wording unchanged'}; cover letter ${cover.letter.method === 'ai' ? 'written with AI' : 'from your profile'}${draft ? '; email ready to review' : ''}`;
      deps.apps.transition(app.id, 'READY', { origin: 'system', message: `Tailored CV ready (${how}${repairs ? `; ${repairs} part(s) kept in your original wording` : ''})` });
      deps.notifier.notify('application.ready', `application:${app.id}:ready:${Date.now()}`, {
        title: `Ready to apply: ${app.jobTitle} at ${app.company}`,
        body: 'Your tailored CV is ready. Review it, then apply.',
        link: `/applications/${app.id}`,
      });
    } catch (raw) {
      // Shutdown: the task goes back to the queue. A timeout counts as a failed attempt like any other error.
      if (ctx.signal.aborted && isShutdown(ctx.signal.reason)) throw raw;
      const err = classify(raw);
      if (err instanceof PermanentError || ctx.attempt >= MAX_ATTEMPTS) {
        if (deps.apps.get(app.id)?.status === 'PREPARING') fail(deps, app, err.message);
        deps.log.warn({ applicationId: app.id, error: err.message }, 'application preparation failed');
        return;
      }
      throw err;
    }
  };
}

/** Renders the PDF again from the saved tailored CV (after an edit or a template change). */
export function createRenderHandler(deps: PrepareDeps): TaskHandler {
  return async (payload, ctx) => {
    const parsed = Payload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid application.render payload');
    const app = deps.apps.get(parsed.data.applicationId);
    const doc = app ? deps.apps.tailoredCv(app.id) : null;
    const profile = app ? deps.profiles.get(app.profileId) : null;
    // Once sent (or being sent), the documents are the record of what went out: never re-render them.
    if (!app || !doc || !profile || !deps.apps.canEdit(app.id)) return;
    // Each save replaces the document row, so its id tells whether the CV or letter changed while we rendered.
    const version = () => `${deps.apps.document(app.id, 'tailored_cv_json')?.id}:${deps.apps.document(app.id, 'cover_letter')?.id}`;
    const before = version();
    try {
      await renderDocuments(deps, app, profile.data, doc);
      if (version() !== before) throw new RetryLaterError(0, 'The CV changed while it was being rendered');
      deps.apps.addEvent(app.id, 'rendered', 'system', `PDFs updated: CV${deps.apps.document(app.id, 'cover_letter') ? ' and cover letter' : ''} (${doc.template} template)`);
    } catch (raw) {
      if (raw instanceof RetryLaterError) throw raw;
      if (ctx.signal.aborted && isShutdown(ctx.signal.reason)) throw raw;
      const err = classify(raw);
      if (err instanceof PermanentError || ctx.attempt >= MAX_ATTEMPTS) {
        deps.apps.addEvent(app.id, 'render_failed', 'system', `Couldn't render the CV: ${err.message}`);
        return;
      }
      throw err;
    }
  };
}

/**
 * Applications must never wait in PREPARING forever: if their preparation task gave up (timeouts, crashes) they
 * are marked failed with the reason, so the user can retry; if no task is left at all, preparation is queued again.
 */
export function reconcilePreparation(deps: { apps: ApplicationService; queue: Queue }): { failed: number; requeued: number } {
  let failed = 0;
  let requeued = 0;
  const preparing = deps.apps.list({ status: 'PREPARING', pageSize: 200 }).items;
  if (!preparing.length) return { failed, requeued };
  const tasks = deps.queue.recent(PREPARE_TASK, 1000);
  for (const app of preparing) {
    const latest = tasks.find((t) => (t.payload as { applicationId?: number })?.applicationId === app.id);
    if (latest && (latest.status === 'pending' || latest.status === 'running')) continue;
    if (latest?.status === 'failed') {
      const reason = latest.lastError ?? 'Preparation stopped unexpectedly.';
      deps.apps.transition(app.id, 'PREPARATION_FAILED', { origin: 'system', message: `Couldn't prepare the application: ${reason}`, failureCode: 'CV_GENERATION_FAILED', failureReason: reason });
      failed++;
    } else {
      deps.queue.enqueue(PREPARE_TASK, { applicationId: app.id }, { dedupeKey: `${PREPARE_TASK}:${app.id}` });
      requeued++;
    }
  }
  return { failed, requeued };
}
