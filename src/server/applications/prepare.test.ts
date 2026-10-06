import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import type { Ai } from '../ai';
import { routedAi } from '../ai/fake';
import { notifications, sources } from '../db/schema';
import { createIngestor } from '../jobs/ingest';
import { createLogger } from '../logging';
import { createMatchService } from '../matching/service';
import { createNotifier } from '../notifications/dispatcher';
import { assignIds, DEFAULT_PREFERENCES, emptyProfile } from '../profile/model';
import { createProfileService } from '../profile/service';
import { createQueue, PermanentError, RetryLaterError } from '../queue';
import { createSettings } from '../settings';
import { createFileStore } from '../storage';
import type { PdfRenderer } from '../tailoring/render';
import { createPrepareHandler, createRenderHandler, reconcilePreparation } from './prepare';
import { ShutdownError, TaskTimeoutError } from '../queue/runner';
import { PREPARE_TASK } from '../matching/service';
import { createApplicationService } from './service';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

const JD = 'Requirements\n• 3+ years of experience\n• Go\n• PostgreSQL\nNice to have\n• Docker';

async function setup(render: PdfRenderer['render'] = async () => Buffer.from('%PDF-1.7 fake'), description = JD) {
  const files = createFileStore(path.join(t.dir, 'files'));
  const profiles = createProfileService({ db: t.db, files });
  const queue = createQueue(t.db);
  const settings = createSettings(t.db);
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
  const apps = createApplicationService({ db: t.db, files, queue, profiles });
  const notifier = createNotifier({ db: t.db, settings, queue });
  const p = profiles.create('Engineer');
  const data = emptyProfile();
  data.personal.fullName = 'Asha Rao';
  data.headline = 'Backend Engineer';
  data.yearsExperience = 5;
  data.skills = ['Go', 'PostgreSQL', 'Docker', 'React'].map((name) => ({ id: '', name, category: 'technology' as const }));
  data.experience = [
    { id: '', title: 'Backend Engineer', company: 'Example Co', location: 'Pune', startDate: '2020-01', endDate: null, current: true, summary: null, bullets: [{ id: '', text: 'Built Go services handling 2M requests a day' }, { id: '', text: 'Tuned PostgreSQL queries, cutting p95 latency by 40%' }] },
  ];
  profiles.updateData(p.id, assignIds(data), { byUser: true });
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 100);
  const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme careers', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const [jobId] = createIngestor({ db: t.db }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://x.example/1', title: 'Backend Engineer', company: 'Acme', location: 'Remote', description }], { completeSnapshot: false }).changedJobIds;
  const m = await matching.evaluate(jobId, p.id);
  const app = matching.approve(m.matchId);
  const htmls: string[] = [];
  const pdf: PdfRenderer = { render: async (html) => (htmls.push(html), render(html)), close: async () => {} };
  const deps = { apps, profiles, matching, ai: null, pdf, notifier, log };
  const ctx = (attempt = 1) => ({ taskId: 1, attempt, log, signal: new AbortController().signal });
  return { apps, app, deps, ctx, htmls, files };
}

describe('application.prepare', () => {
  it('stops spending AI as soon as the application is withdrawn mid-preparation (M5 deferred minor)', async () => {
    const { apps, app, deps, ctx } = await setup();
    const tasks: string[] = [];
    const ai = routedAi(['cv-tailor', 'cover-letter'], async (req: { task: string }) => {
        tasks.push(req.task);
        apps.withdraw(app.id); // the user withdraws while the CV is being tailored
        throw new Error('slow model');
      },) as unknown as Ai;
    await createPrepareHandler({ ...deps, ai })({ applicationId: app.id }, ctx());
    expect(tasks).toEqual(['cv-tailor']);
    expect(apps.get(app.id)?.status).toBe('WITHDRAWN');
  });

  it('prepares a grounded tailored CV with PDF, HTML and change report, then marks it ready and notifies', async () => {
    const { apps, app, deps, ctx, htmls, files } = await setup();
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)?.status).toBe('READY');
    const docs = apps.documents(app.id);
    expect(docs.map((d) => d.kind).sort()).toEqual(['change_report', 'cover_letter', 'cover_letter_pdf', 'tailored_cv_html', 'tailored_cv_json', 'tailored_cv_pdf']);
    expect(apps.coverLetter(app.id)?.letter.paragraphs.join(' ')).toContain('Backend Engineer');
    expect(docs.find((d) => d.kind === 'cover_letter_pdf')?.filename).toBe('Acme_Backend_Engineer_Cover_Letter.pdf');
    expect(apps.emailDraft(app.id)).toBeNull(); // this job takes no email applications
    const pdfDoc = docs.find((d) => d.kind === 'tailored_cv_pdf')!;
    expect(pdfDoc.filename).toBe('Acme_Backend_Engineer_CV.pdf');
    expect((await files.read(pdfDoc.path)).toString()).toMatch(/^%PDF/);
    expect(htmls[0]).toContain('Asha Rao');
    expect(htmls[0]).toContain('2M requests');
    expect(apps.tailoredCv(app.id)?.cv.method).toBe('offline');
    expect(apps.timeline(app.id).at(-1)?.message).toMatch(/ready/i);
    expect(t.db.select().from(notifications).all().some((n) => n.event === 'application.ready' && n.link === `/applications/${app.id}`)).toBe(true);
  });

  it('drafts the application email when the job takes applications by email', async () => {
    const { apps, app, deps, ctx } = await setup(undefined, `${JD}\n\nTo apply, email your CV to careers@acme.example`);
    expect(app.applyEmail).toBe('careers@acme.example');
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    expect(apps.emailDraft(app.id)).toMatchObject({ to: 'careers@acme.example', subject: 'Application for Backend Engineer – Asha Rao', attachCoverLetter: false });
    expect(apps.emailDraft(app.id)?.body).toContain('Dear Acme hiring team,');
  });

  it('leaves alone an application that is no longer being prepared', async () => {
    const { apps, app, deps, ctx, htmls } = await setup();
    apps.withdraw(app.id);
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)?.status).toBe('WITHDRAWN');
    expect(htmls).toHaveLength(0);
  });

  it('fails with a clear reason when PDF rendering is not installed, and says so', async () => {
    const { apps, app, deps, ctx } = await setup(async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome");
    });
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    expect(apps.get(app.id)).toMatchObject({ status: 'PREPARATION_FAILED', failureCode: 'CV_GENERATION_FAILED', failureReason: expect.stringMatching(/playwright install chromium/) });
    expect(t.db.select().from(notifications).all().some((n) => n.event === 'application.failed')).toBe(true);
  });

  it('retries temporary failures and gives up with a reason on the last attempt', async () => {
    const { apps, app, deps, ctx } = await setup(async () => {
      throw new Error('Target page, context or browser has been closed');
    });
    await expect(createPrepareHandler(deps)({ applicationId: app.id }, ctx(1))).rejects.toThrow(/closed/);
    expect(apps.get(app.id)?.status).toBe('PREPARING');
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx(3));
    expect(apps.get(app.id)).toMatchObject({ status: 'PREPARATION_FAILED', failureReason: expect.stringMatching(/closed/) });
  });
});

describe('stuck preparation', () => {
  const aborted = (reason: Error, attempt: number) => {
    const ac = new AbortController();
    ac.abort(reason);
    return { taskId: 1, attempt, log, signal: ac.signal };
  };

  it('a timed-out last attempt fails the application; a shutdown leaves it for the next start', async () => {
    const { apps, app, deps } = await setup(async () => {
      throw new Error('This operation was aborted');
    });
    await expect(createPrepareHandler(deps)({ applicationId: app.id }, aborted(new ShutdownError('Worker shutting down'), 3))).rejects.toThrow();
    expect(apps.get(app.id)?.status).toBe('PREPARING');
    await createPrepareHandler(deps)({ applicationId: app.id }, aborted(new TaskTimeoutError('Task timed out after 600000 ms'), 3));
    expect(apps.get(app.id)).toMatchObject({ status: 'PREPARATION_FAILED' });
  });

  it('reconciliation fails applications whose preparation task gave up, and re-queues lost ones', async () => {
    const { apps, app } = await setup();
    const queue = createQueue(t.db);
    const task = queue.claim('w', [PREPARE_TASK])!;
    queue.fail(task.id, new PermanentError('Chromium crashed the worker'));
    expect(reconcilePreparation({ apps, queue })).toEqual({ failed: 1, requeued: 0 });
    expect(apps.get(app.id)).toMatchObject({ status: 'PREPARATION_FAILED', failureReason: expect.stringMatching(/Chromium crashed/) });

    apps.retryPreparation(app.id);
    queue.complete(queue.claim('w', [PREPARE_TASK])!.id); // finished without moving the application on
    expect(reconcilePreparation({ apps, queue })).toEqual({ failed: 0, requeued: 1 });
    expect(queue.claim('w', [PREPARE_TASK])?.payload).toEqual({ applicationId: app.id });
  });
});

describe('application.render', () => {
  it('renders the PDF again from the edited CV', async () => {
    const { apps, app, deps, ctx, htmls } = await setup();
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    const saved = apps.tailoredCv(app.id)!;
    expect((await apps.saveEditedCv(app.id, { ...saved.cv, summary: 'Backend engineer who builds Go services.' })).ok).toBe(true);
    const before = htmls.length;
    await createRenderHandler(deps)({ applicationId: app.id }, ctx());
    // The CV and the cover letter are both rendered again.
    expect(htmls.length - before).toBe(2);
    expect(htmls.slice(before).some((h) => h.includes('Backend engineer who builds Go services.'))).toBe(true);
    expect(apps.timeline(app.id).at(-1)?.type).toBe('rendered');
    expect(apps.documents(app.id).filter((d) => d.kind === 'tailored_cv_pdf')).toHaveLength(1);
  });

  it('an edit saved while the PDF is being rendered gets rendered too', async () => {
    let editDuringRender: (() => Promise<void>) | null = null;
    const { apps, app, deps, ctx, htmls } = await setup(async () => {
      const edit = editDuringRender;
      editDuringRender = null;
      if (edit) await edit();
      return Buffer.from('%PDF-1.7 fake');
    });
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    const saved = apps.tailoredCv(app.id)!;
    editDuringRender = async () => void (await apps.saveEditedCv(app.id, { ...saved.cv, summary: 'Second edit, saved mid-render.' }));
    await expect(createRenderHandler(deps)({ applicationId: app.id }, ctx())).rejects.toBeInstanceOf(RetryLaterError);
    await createRenderHandler(deps)({ applicationId: app.id }, ctx());
    expect(htmls.some((h) => h.includes('Second edit, saved mid-render.'))).toBe(true);
    expect(apps.pdfOutdated(app.id)).toBe(false);
  });

  it('does not re-render the documents of an application that was already sent', async () => {
    const { apps, app, deps, ctx, htmls } = await setup();
    await createPrepareHandler(deps)({ applicationId: app.id }, ctx());
    apps.markApplied(app.id);
    const before = htmls.length;
    await createRenderHandler(deps)({ applicationId: app.id }, ctx());
    expect(htmls.length).toBe(before);
  });
});
