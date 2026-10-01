import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '@/server/config';
import { openDb } from '@/server/db';
import { createLogger, type Logger } from '@/server/logging';
import { createQueue } from '@/server/queue';
import { createRunner } from '@/server/queue/runner';
import { createScheduler, SCAN_TASK } from '@/server/scheduler';
import { createSettings } from '@/server/settings';
import { HEARTBEAT_GUARD_MS, HEARTBEAT_KEY, HeartbeatSchema, heartbeatLive, isProcessAlive, type Heartbeat } from '@/server/status/heartbeat';
import { createAi } from '@/server/ai';
import { createCvService, PROFILE_EXTRACT_TASK } from '@/server/profile/cv-service';
import { createProfileService } from '@/server/profile/service';
import { createFileStore } from '@/server/storage';
import { failInterruptedScans } from '@/server/discovery/scan';
import { createHttpClient, type HttpClient } from '@/server/http';
import { createIngestor } from '@/server/jobs/ingest';
import { registerBuiltInAdapters } from '@/server/sources/adapters';
import { createSourceService } from '@/server/sources/service';
import { createMatchService, PREPARE_TASK } from '@/server/matching/service';
import { createApplicationService, EMAIL_TASK, RENDER_TASK } from '@/server/applications/service';
import { createEmailSendHandler } from '@/server/applications/email-send';
import { reconcileApplying } from '@/server/applications/reconcile';
import { createTrackingService } from '@/server/tracking/service';
import { createFailureLog } from '@/server/failures';
import { maintenanceDone, maintenanceDue, pruneOldData, removeOrphanFiles } from '@/server/retention';
import { createInboxPollHandler, INBOX_POLL_TASK } from '@/server/tracking/poll';
import { BROWSER_SETTINGS_KEY, BROWSER_TASK, BrowserSettingsSchema, createBrowserApplyHandler, DEFAULT_BROWSER_SETTINGS } from '@/server/applications/browser-apply';
import { BROWSER_SIGNIN_TASK, createSignInHandler } from '@/server/browser/signin';
import { createBrowserEngine, type BrowserEngine } from '@/server/browser/engine';
import { createPrepareHandler, createRenderHandler, reconcilePreparation } from '@/server/applications/prepare';
import { createPdfRenderer, type PdfRenderer } from '@/server/tailoring/render';
import { createMatchEvaluateHandler, createRescoreHandler, enqueueMatching, MATCH_TASK, reconcileMatches, RESCORE_TASK } from '@/server/matching/tasks';
import { createMailer } from '@/server/email/mailer';
import { createNotifier, NOTIFY_FLUSH_TASK, NOTIFY_SEND_TASK } from '@/server/notifications/dispatcher';
import { notifyNewMatches } from '@/server/notifications/hooks';
import { createDesktopNotifier, createNotifyFlushHandler, createNotifySendHandler } from '@/server/notifications/send';
import { createTelegramBot } from '@/server/notifications/telegram/bot';
import { createTelegramClient } from '@/server/notifications/telegram/client';
import { createDiscoveryScanHandler } from './handlers/discovery-scan';
import { ADD_URL_TASK, createDiscoveryUrlHandler } from './handlers/discovery-url';
import { createProfileExtractHandler } from './handlers/profile-extract';

export class WorkerAlreadyRunningError extends Error {
  override name = 'WorkerAlreadyRunningError';
  constructor(readonly pid: number) {
    super(`Another Job Scraper worker is already running (pid ${pid}). Stop it before starting a new one.`);
  }
}

export interface WorkerHandle {
  workerId: string;
  stop(): Promise<void>;
}

export interface WorkerOptions {
  config: Config;
  log?: Logger;
  pollMs?: number;
  schedulerTickMs?: number;
  heartbeatMs?: number;
  isAlive?: (pid: number) => boolean;
  /** Tests turn this off so no real job sites are contacted. */
  seedDefaultSources?: boolean;
  http?: HttpClient;
  env?: Record<string, string | undefined>;
  /** PDF renderer (tests pass a fake; the default launches headless Chromium on first use). */
  pdf?: PdfRenderer;
  browserEngine?: BrowserEngine;
}

/** Workers running in this process. A heartbeat with our pid but another id is from before a restart (Docker reuses pids). */
const liveWorkers = new Set<string>();

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const { config } = opts;
  const log = opts.log ?? createLogger({ level: config.logLevel, format: config.logFormat, secrets: config.secrets, name: 'job-scraper-worker' });
  const handle = openDb(config.dbPath);
  const settings = createSettings(handle.db);

  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const isAlive = opts.isAlive ?? isProcessAlive;
  // Check and claim the heartbeat in one IMMEDIATE transaction so two workers can't both pass.
  let blockedBy: Heartbeat | null = null;
  settings.update(HEARTBEAT_KEY, HeartbeatSchema.nullable(), null, (hb) => {
    const sameProcess = hb && hb.pid === process.pid && (!hb.host || hb.host === hostname());
    const otherLive = hb && (sameProcess ? Date.now() - hb.at < HEARTBEAT_GUARD_MS && liveWorkers.has(hb.workerId) : heartbeatLive(hb, new Date(), isAlive, hostname(), HEARTBEAT_GUARD_MS));
    if (hb && otherLive) {
      blockedBy = hb;
      return hb;
    }
    return { workerId, pid: process.pid, at: Date.now(), host: hostname() };
  });
  if (blockedBy) {
    handle.close();
    throw new WorkerAlreadyRunningError((blockedBy as Heartbeat).pid);
  }
  liveWorkers.add(workerId);

  const queue = createQueue(handle.db);
  const recovered = queue.recoverStale(0); // single worker: anything "running" was interrupted
  if (recovered > 0) log.warn({ recovered }, 'requeued tasks interrupted by a previous shutdown');

  const scheduler = createScheduler({ settings, queue });
  const files = createFileStore(config.filesDir);
  const profiles = createProfileService({ db: handle.db, files, onChanged: (profileId) => queue.enqueue(RESCORE_TASK, { profileId }, { dedupeKey: `${RESCORE_TASK}:${profileId}` }) });
  const notifier = createNotifier({ db: handle.db, settings, queue });
  // Local calendar day (the AI budget resets at local midnight), for once-a-day alerts.
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ai = createAi({
    db: handle.db,
    settings,
    log,
    onBudgetExceeded: (budget) =>
      notifier.notify('budget.exhausted', `budget:${today()}`, { title: 'Daily AI budget reached', body: `$${budget.toFixed(2)} spent today. Job Scraper uses offline rules until tomorrow.`, link: '/settings/ai' }),
  });
  const cvs = createCvService({ db: handle.db, files, queue, profiles, ai, log });
  const recoveredCvs = cvs.recoverInterrupted();
  if (recoveredCvs > 0) log.warn({ recoveredCvs }, 'requeued CV extractions interrupted by a previous shutdown');
  const MINUTE = 60_000;
  registerBuiltInAdapters();
  const sources = createSourceService({ db: handle.db, settings });
  if (opts.seedDefaultSources !== false) sources.ensureDefaults();
  const interruptedScans = failInterruptedScans(handle.db);
  if (interruptedScans > 0) log.warn({ interruptedScans }, 'marked scans interrupted by a previous shutdown as failed');
  const ingestor = createIngestor({ db: handle.db });
  const http = opts.http ?? createHttpClient();
  const matching = createMatchService({ db: handle.db, ai, queue, profiles, log });
  const appUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  const env = opts.env ?? process.env;
  const telegramClient = env.TELEGRAM_BOT_TOKEN ? createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN }) : null;
  const telegramChatId = env.TELEGRAM_ALLOWED_CHAT_ID?.trim() || null;
  const failures = createFailureLog(settings);
  const discoveryDeps = {
    failures,
    settings,
    db: handle.db,
    sources,
    profiles,
    ingestor,
    http,
    log,
    env,
    ai,
    onChangedJobs: (jobIds: number[]) => {
      const tasks = enqueueMatching(queue, jobIds, undefined, { profiles: profiles.list().length });
      log.info({ changedJobs: jobIds.length, matchTasks: tasks }, 'queued matching for new and changed jobs');
    },
    afterScan: () => {
      reconcileMatches({ matching, profiles, queue });
    },
    onSourceFailing: (source: { id: number; name: string }, error: string, disabled: boolean) =>
      notifier.notify('source.failing', `source:${source.id}:${today()}`, {
        title: disabled ? `${source.name} was switched off` : `${source.name} keeps failing`,
        body: disabled ? `It failed several times in a row, so Job Scraper stopped using it. ${error}` : error,
        link: '/sources',
      }),
  };
  const apps = createApplicationService({ db: handle.db, files, queue, profiles });
  // One headless Chromium for all PDF renders, started on first use and closed on shutdown.
  const pdf = opts.pdf ?? createPdfRenderer();
  const prepareDeps = { apps, profiles, matching, ai, pdf, notifier, log };
  const tracking = createTrackingService({ db: handle.db, apps, settings });
  const mailer = createMailer({ env, settings });
  // Visible by default (PRD §46); headless in Docker/CI or when the user turns it off.
  const browserEngine =
    opts.browserEngine ??
    createBrowserEngine({
      profilesDir: path.join(config.dataDir, 'browser-profiles'),
      headless: () => env.JOB_SCRAPER_BROWSER_HEADLESS === 'true' || !settings.get(BROWSER_SETTINGS_KEY, BrowserSettingsSchema, DEFAULT_BROWSER_SETTINGS).visible,
    });
  const sendDeps = {
    notifier,
    appUrl,
    mailer,
    desktop: createDesktopNotifier(),
    telegram: telegramClient ? { client: telegramClient, chatId: telegramChatId } : null,
    emailTo: () => profiles.getDefault()?.data.personal.email ?? null,
  };
  const runner = createRunner({
    queue,
    workerId,
    log,
    pollMs: opts.pollMs ?? 1000,
    handlers: {
      [SCAN_TASK]: {
        handle: createDiscoveryScanHandler(discoveryDeps),
        concurrency: 1,
        timeoutMs: 30 * MINUTE,
      },
      [MATCH_TASK]: {
        handle: createMatchEvaluateHandler({
          matching,
          profiles,
          failures,
          onSurfaced: (matchIds) => {
            log.info({ newMatches: matchIds.length }, 'new matching jobs');
            // The matches are already saved: a notification problem must not re-run (and so lose) them.
            try {
              notifyNewMatches({ notifier, matching, profiles }, matchIds);
            } catch (err) {
              log.error({ err }, 'could not record notifications for new matches');
            }
          },
        }),
        concurrency: 2,
        timeoutMs: 20 * MINUTE,
      },
      [RESCORE_TASK]: { handle: createRescoreHandler({ matching, queue }), concurrency: 1, timeoutMs: MINUTE },
      [NOTIFY_SEND_TASK]: { handle: createNotifySendHandler(sendDeps), concurrency: 3, timeoutMs: MINUTE },
      [NOTIFY_FLUSH_TASK]: { handle: createNotifyFlushHandler(sendDeps), concurrency: 3, timeoutMs: 3 * MINUTE },
      [PREPARE_TASK]: { handle: createPrepareHandler(prepareDeps), concurrency: 2, timeoutMs: 10 * MINUTE },
      [RENDER_TASK]: { handle: createRenderHandler(prepareDeps), concurrency: 1, timeoutMs: 2 * MINUTE },
      [EMAIL_TASK]: { handle: createEmailSendHandler({ apps, mailer, notifier, log }), concurrency: 1, timeoutMs: 2 * MINUTE },
      [BROWSER_TASK]: {
        handle: createBrowserApplyHandler({ apps, profiles, engine: browserEngine, ai, notifier, settings, files, log, allowPrivateUrls: env.JOB_SCRAPER_ALLOW_PRIVATE_URLS === 'true' }),
        concurrency: 2,
        timeoutMs: 10 * MINUTE,
      },
      [BROWSER_SIGNIN_TASK]: { handle: createSignInHandler(browserEngine), concurrency: 1, timeoutMs: 16 * MINUTE },
      [INBOX_POLL_TASK]: { handle: createInboxPollHandler({ tracking, apps, ai, notifier, settings, env, log }), concurrency: 1, timeoutMs: 10 * MINUTE },
      [ADD_URL_TASK]: { handle: createDiscoveryUrlHandler(discoveryDeps), concurrency: 2, timeoutMs: 3 * MINUTE },
      [PROFILE_EXTRACT_TASK]: { handle: createProfileExtractHandler({ cvs }), concurrency: 2, timeoutMs: 5 * MINUTE },
    },
  });

  const beat = () => {
    try {
      settings.set(HEARTBEAT_KEY, { workerId, pid: process.pid, at: Date.now(), host: hostname() });
    } catch (err) {
      log.error({ err }, 'heartbeat write failed');
    }
  };
  const schedulerTick = () => {
    try {
      scheduler.tick();
    } catch (err) {
      log.error({ err }, 'scheduler tick failed');
    }
  };

  beat();
  schedulerTick();
  const timers = [
    setInterval(beat, opts.heartbeatMs ?? 5000),
    setInterval(schedulerTick, opts.schedulerTickMs ?? 15_000),
  ];
  const reconcileApps = () => {
    try {
      const r = reconcilePreparation({ apps, queue });
      if (r.failed || r.requeued) log.info(r, 'reconciled applications left preparing');
      const a = reconcileApplying({ apps, queue });
      if (a.failed || a.uncertain) log.info(a, 'reconciled applications left applying');
    } catch (err) {
      log.error({ err }, 'application reconciliation failed');
    }
  };
  reconcileApps();
  timers.push(setInterval(reconcileApps, 60_000));
  // Replies to applications: checked every 15 minutes while inbox tracking is on (Settings → Tracking).
  const pollInbox = () => {
    try {
      if (tracking.settings().inboxEnabled) queue.enqueue(INBOX_POLL_TASK, {}, { dedupeKey: INBOX_POLL_TASK });
    } catch (err) {
      log.error({ err }, 'could not schedule the inbox check');
    }
  };
  pollInbox();
  timers.push(setInterval(pollInbox, 15 * MINUTE));
  // Daily: remove old history; weekly (counted across restarts): reclaim space and refresh the planner's statistics.
  const prune = () => {
    try {
      const r = pruneOldData(handle.db);
      if (Object.values(r).some((n) => n > 0)) log.info(r, 'pruned old history');
    } catch (err) {
      log.warn({ err }, 'pruning skipped');
    }
    removeOrphanFiles(handle.db, files)
      .then((n) => n > 0 && log.info({ folders: n }, 'removed files of deleted applications and profiles'))
      .catch((err) => log.warn({ err }, 'could not remove leftover files'));
    try {
      if (maintenanceDue(settings)) {
        handle.sqlite.pragma('optimize');
        handle.sqlite.exec('VACUUM');
        maintenanceDone(settings);
        log.info('database maintenance done');
      }
    } catch (err) {
      log.warn({ err }, 'database maintenance skipped');
    }
  };
  prune();
  timers.push(setInterval(prune, 24 * 60 * MINUTE));
  const reconciled = reconcileMatches({ matching, profiles, queue });
  if (reconciled > 0) log.info({ tasks: reconciled }, 'queued matching for jobs left unmatched');
  runner.start();
  const botAbort = new AbortController();
  let botRun: Promise<void> | null = null;
  if (telegramClient) {
    const bot = createTelegramBot({ client: telegramClient, allowedChatId: telegramChatId, settings, matching, profiles, scheduler, appUrl, log });
    botRun = bot.run(botAbort.signal).catch((err) => log.error({ err }, 'Telegram bot stopped'));
    log.info({ allowedChat: telegramChatId ? 'set' : 'not set' }, 'Telegram bot listening');
  }
  log.info({ workerId, dataDir: config.dataDir }, 'Job Scraper worker started');

  return {
    workerId,
    async stop() {
      botAbort.abort();
      timers.forEach(clearInterval);
      await runner.stop();
      // Let an update being handled finish (it writes the offset) before the database closes.
      if (botRun) await Promise.race([botRun, new Promise((r) => setTimeout(r, 5_000))]);
      await pdf.close();
      settings.set(HEARTBEAT_KEY, { workerId, pid: process.pid, at: 0, host: hostname() });
      liveWorkers.delete(workerId);
      handle.close();
      log.info({ workerId }, 'Job Scraper worker stopped');
    },
  };
}
