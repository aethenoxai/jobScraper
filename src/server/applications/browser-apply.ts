/**
 * The "Apply in browser" task (PRD §25–27): runs the website application, then records the outcome with its
 * evidence. Limits: a daily cap and one submission per site per minute. A Submit that may have gone through is
 * never repeated (N8): an interrupted attempt after Submit ends as NO_CONFIRMATION for the user to check.
 */
import { z } from 'zod';
import type { Ai } from '../ai';
import { applyOnWebsite } from '../browser/run';
import type { BrowserEngine } from '../browser/engine';
import { siteKey } from '../browser/engine';
import { NEVER_FETCH } from '../discovery/web';
import { isPublicHttpUrl } from '../http';
import type { Logger } from '../logging';
import { resolvePlaces } from '../matching/geo';
import type { Notifier } from '../notifications/dispatcher';
import type { ProfileService } from '../profile/service';
import { PermanentError, RetryLaterError } from '../queue';
import { isShutdown, type TaskHandler } from '../queue/runner';
import type { SettingsStore } from '../settings';
import type { FileStore } from '../storage';
import type { ApplicationRecord, ApplicationService } from './service';

export { BROWSER_TASK } from './service';

export const BROWSER_SETTINGS_KEY = 'browser';
export const BrowserSettingsSchema = z.object({ visible: z.boolean(), dailyCap: z.number().int().min(1).max(200) });
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>;
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { visible: true, dailyCap: 25 };

const Payload = z.object({ applicationId: z.number().int() });
const SUBMIT_EVENT = 'browser_submit_clicked';
const SITE_GAP_MS = 60_000;
const MAX_ATTEMPTS = 3;

export interface BrowserApplyDeps {
  apps: ApplicationService;
  profiles: ProfileService;
  engine: BrowserEngine;
  ai: Ai | null;
  notifier: Notifier;
  settings: SettingsStore;
  files: FileStore;
  log: Logger;
  now?: () => Date;
  /** Tests and local fixture sites only. */
  allowPrivateUrls?: boolean;
}

/** The application is no longer ours to run (withdrawn meanwhile, or Submit already clicked). */
class NotRunnable extends Error {}

/** Whether this attempt (since the application last entered APPLYING) already clicked Submit. */
function submitClicked(apps: ApplicationService, id: number): boolean {
  const events = apps.timeline(id);
  const start = events.findLastIndex((e) => e.type === 'status' && (e.payload as { to?: string } | null)?.to === 'APPLYING');
  return events.slice(start + 1).some((e) => e.type === SUBMIT_EVENT);
}

export function createBrowserApplyHandler(deps: BrowserApplyDeps): TaskHandler {
  const { apps } = deps;
  const now = deps.now ?? (() => new Date());

  const finish = (app: ApplicationRecord, to: 'APPLICATION_SKIPPED' | 'APPLICATION_FAILED', code: string, reason: string) => {
    apps.transition(app.id, to, { origin: 'system', message: reason, failureCode: code, failureReason: reason });
    deps.notifier.notify('application.failed', `application:${app.id}:browser:${Date.now()}`, { title: `${to === 'APPLICATION_SKIPPED' ? 'Skipped' : 'Not applied'}: ${app.jobTitle} at ${app.company}`, body: reason, link: `/applications/${app.id}` });
  };

  return async (payload, ctx) => {
    const parsed = Payload.safeParse(payload);
    if (!parsed.success) throw new PermanentError('Invalid application.browser payload');
    const app = apps.get(parsed.data.applicationId);
    if (!app || app.status !== 'APPLYING') return;

    if (submitClicked(apps, app.id)) {
      return finish(app, 'APPLICATION_FAILED', 'NO_CONFIRMATION', 'Job Scraper was interrupted after submitting the form, so it does not know whether the application went through. Check your email or the site before applying again.');
    }
    const url = app.applicationUrl ?? app.sourceUrl;
    if (!/^https?:\/\//i.test(url) || (!deps.allowPrivateUrls && !isPublicHttpUrl(url))) return finish(app, 'APPLICATION_FAILED', 'UNSUPPORTED_APPLICATION_FLOW', 'The job’s web address cannot be opened safely.');
    if (NEVER_FETCH.test(new URL(url).hostname)) return finish(app, 'APPLICATION_FAILED', 'UNSUPPORTED_APPLICATION_FLOW', `Job Scraper doesn't automate ${new URL(url).hostname}. Apply on the site yourself.`);

    const site = siteKey(url);
    /** Daily cap and per-site pacing; checked now and again inside the site lock (another run may just have submitted). */
    const checkLimits = () => {
      const settings = deps.settings.get(BROWSER_SETTINGS_KEY, BrowserSettingsSchema, DEFAULT_BROWSER_SETTINGS);
      const t = now();
      const midnight = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      const today = apps.eventsSince(SUBMIT_EVENT, midnight);
      if (today.length >= settings.dailyCap) {
        const resume = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + 1, 0, 5);
        if (!apps.timeline(app.id).some((e) => e.type === 'browser_waiting' && e.occurredAt >= midnight)) apps.addEvent(app.id, 'browser_waiting', 'system', `Daily limit of ${settings.dailyCap} website applications reached; continues tomorrow.`);
        throw new RetryLaterError(resume.getTime() - t.getTime(), 'Daily application limit reached');
      }
      const last = today.find((e) => (e.payload as { site?: string } | null)?.site === site);
      if (last && t.getTime() - last.occurredAt.getTime() < SITE_GAP_MS) throw new RetryLaterError(SITE_GAP_MS - (t.getTime() - last.occurredAt.getTime()), 'Pacing submissions to one site');
    };
    checkLimits();

    const profile = deps.profiles.get(app.profileId);
    const cv = apps.document(app.id, 'tailored_cv_pdf');
    if (!profile || !cv) return finish(app, 'APPLICATION_FAILED', 'UNSUPPORTED_APPLICATION_FLOW', !profile ? 'The profile of this application was deleted.' : 'The tailored CV PDF is missing.');
    const letter = apps.document(app.id, 'cover_letter_pdf');
    const countries = resolvePlaces(app.location).countries;

    try {
      const outcome = await applyOnWebsite(deps.engine, {
        url,
        profile: profile.data,
        cvFile: deps.files.resolve(cv.path),
        coverLetterFile: letter ? deps.files.resolve(letter.path) : null,
        ai: deps.ai,
        job: { title: app.jobTitle, company: app.company },
        jobCountry: countries.size === 1 ? [...countries][0] : null,
        heading: `${app.jobTitle} at ${app.company}`,
        log: (step) => apps.addEvent(app.id, 'browser_step', 'system', step),
        onSubmitting: () => apps.addEvent(app.id, SUBMIT_EVENT, 'system', 'Submitted the application form', { site }),
        signal: ctx.signal,
        allowPrivateUrls: deps.allowPrivateUrls,
        beforeStart: () => {
          if (apps.get(app.id)?.status !== 'APPLYING' || submitClicked(apps, app.id)) throw new NotRunnable();
          checkLimits();
        },
      });
      // The outcome matters more than its picture: a failed save must not turn "applied" into an error.
      if (outcome.screenshot) await apps.saveDocument(app.id, 'screenshot', `screenshot-${now().getTime()}.png`, 'image/png', outcome.screenshot).catch((err) => deps.log.warn({ applicationId: app.id, error: err instanceof Error ? err.message : String(err) }, 'could not save the application screenshot'));
      if (outcome.result === 'applied') {
        apps.transition(app.id, 'APPLIED', { origin: 'observed', message: `The site confirmed the application: ${outcome.evidence}`, payload: { site } });
        deps.notifier.notify('application.applied', `application:${app.id}:applied`, { title: `Applied: ${app.jobTitle} at ${app.company}`, body: `The site confirmed your application.`, link: `/applications/${app.id}` });
        return;
      }
      return finish(app, outcome.result === 'skipped' ? 'APPLICATION_SKIPPED' : 'APPLICATION_FAILED', outcome.code, outcome.reason);
    } catch (err) {
      if (err instanceof RetryLaterError) throw err;
      if (err instanceof NotRunnable) {
        const fresh = apps.get(app.id);
        if (fresh?.status === 'APPLYING' && submitClicked(apps, app.id)) return finish(fresh, 'APPLICATION_FAILED', 'NO_CONFIRMATION', 'Job Scraper was interrupted after submitting the form, so it does not know whether the application went through. Check your email or the site before applying again.');
        return;
      }
      if (ctx.signal.aborted && isShutdown(ctx.signal.reason)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (submitClicked(apps, app.id)) return finish(app, 'APPLICATION_FAILED', 'NO_CONFIRMATION', `The browser stopped after submitting (${message}). Check your email or the site before applying again.`);
      if (ctx.attempt >= MAX_ATTEMPTS) return finish(app, 'APPLICATION_FAILED', 'BROWSER_ERROR', `The browser could not complete the application: ${message}`);
      deps.log.warn({ applicationId: app.id, error: message }, 'browser application attempt failed; retrying');
      throw err;
    }
  };
}
