import { createAi, type Ai } from './ai';
import { loadConfig, type Config } from './config';
import { openDb, type Db } from './db';
import { createLogger, type Logger } from './logging';
import { createQueue, type Queue } from './queue';
import { createScheduler, type Scheduler } from './scheduler';
import { createSettings, type SettingsStore } from './settings';
import { createCvService, type CvService } from './profile/cv-service';
import { createProfileService, type ProfileService } from './profile/service';
import { createIngestor, type Ingestor } from './jobs/ingest';
import { createApplicationService, type ApplicationService } from './applications/service';
import { createMatchService, type MatchService } from './matching/service';
import { createTrackingService, type TrackingService } from './tracking/service';
import { RESCORE_TASK } from './matching/tasks';
import { createNotifier, type Notifier } from './notifications/dispatcher';
import { isOnboarded } from './onboarding';
import { registerBuiltInAdapters } from './sources/adapters';
import { createSourceService, type SourceService } from './sources/service';
import { createFileStore, type FileStore } from './storage';

export interface AppContext {
  config: Config;
  db: Db;
  settings: SettingsStore;
  queue: Queue;
  scheduler: Scheduler;
  files: FileStore;
  log: Logger;
  ai: Ai;
  profiles: ProfileService;
  cvs: CvService;
  sources: SourceService;
  ingestor: Ingestor;
  matching: MatchService;
  notifier: Notifier;
  apps: ApplicationService;
  tracking: TrackingService;
}

// Cached on globalThis so Next.js dev hot-reloads reuse one DB connection.
const holder = globalThis as typeof globalThis & { __jobScraperContext?: AppContext };

export function getAppContext(): AppContext {
  registerBuiltInAdapters(); // idempotent; cheap
  if (!holder.__jobScraperContext) {
    const config = loadConfig();
    const { db } = openDb(config.dbPath);
    const settings = createSettings(db);
    const queue = createQueue(db);
    const files = createFileStore(config.filesDir);
    const log = createLogger({ level: config.logLevel, format: config.logFormat, secrets: config.secrets, name: 'job-scraper-web' });
    // Any profile change (editor, CV import, preferences, duplicate) re-matches that profile in the worker.
    const profiles = createProfileService({ db, files, onChanged: (profileId) => queue.enqueue(RESCORE_TASK, { profileId }, { dedupeKey: `${RESCORE_TASK}:${profileId}` }) });
    const ai = createAi({ db, settings, log });
    const apps = createApplicationService({ db, files, queue, profiles });
    holder.__jobScraperContext = {
      config,
      db,
      settings,
      queue,
      // Nothing is searched before onboarding is finished.
      scheduler: createScheduler({ settings, queue, canScan: () => isOnboarded({ settings, profiles }) }),
      files,
      log,
      ai,
      profiles,
      // The web process never runs extraction itself (it only uploads and enqueues), so it gets no AI here.
      cvs: createCvService({ db, files, queue, profiles, ai: null, log }),
      sources: createSourceService({ db, settings }),
      ingestor: createIngestor({ db }),
      // The web process only reads matches and records decisions; evaluation runs in the worker (no AI here).
      matching: createMatchService({ db, ai: null, queue, profiles, log }),
      notifier: createNotifier({ db, settings, queue }),
      apps,
      tracking: createTrackingService({ db, apps, settings }),
    };
  }
  return holder.__jobScraperContext;
}
