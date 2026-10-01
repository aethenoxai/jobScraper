import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const TASK_STATUSES = ['pending', 'running', 'done', 'failed'] as const;

export const queueTasks = sqliteTable(
  'queue_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: TASK_STATUSES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('queue_tasks_claim_idx').on(t.status, t.runAt), index('queue_tasks_dedupe_idx').on(t.dedupeKey)],
);

export const SCAN_TRIGGERS = ['schedule', 'manual'] as const;
export const SCAN_STATUSES = ['running', 'success', 'partial', 'failed', 'skipped'] as const;

export const scanRuns = sqliteTable('scan_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trigger: text('trigger', { enum: SCAN_TRIGGERS }).notNull(),
  status: text('status', { enum: SCAN_STATUSES }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  stats: text('stats', { mode: 'json' }).$type<Record<string, number>>(),
  error: text('error'),
});

export const profiles = sqliteTable('profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /** Structured profile (ProfileData); validated by the profile model. */
  data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  /** Job-search preferences (Preferences). */
  preferences: text('preferences', { mode: 'json' }).$type<unknown>().notNull(),
  sliderValue: integer('slider_value').notNull().default(100),
  /** True once the user saved the profile by hand; extraction then goes to review instead of overwriting. */
  userEdited: integer('user_edited', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const MASTER_CV_STATUSES = ['uploaded', 'extracting', 'extracted', 'applied', 'dismissed', 'failed'] as const;

export const masterCvs = sqliteTable(
  'master_cvs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: MASTER_CV_STATUSES }).notNull(),
    extractedText: text('extracted_text'),
    /** Extracted ProfileData awaiting review (or already applied). */
    extraction: text('extraction', { mode: 'json' }).$type<unknown>(),
    extractionMethod: text('extraction_method', { enum: ['ai', 'heuristic'] }),
    error: text('error'),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('master_cvs_profile_idx').on(t.profileId)],
);

export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task: text('task').notNull(),
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);

export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  adapterId: text('adapter_id').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Adapter-specific configuration (validated by the adapter's schema). */
  config: text('config', { mode: 'json' }).$type<unknown>().notNull(),
  /** How the source was added: seeded default, by the user, or discovered on the web. */
  origin: text('origin', { enum: ['default', 'user', 'discovered'] }).notNull(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastStatus: text('last_status', { enum: ['success', 'failed', 'skipped'] }),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Set when a source asked us to back off (Retry-After); the scanner skips it until then. */
  notBefore: integer('not_before', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sourceRuns = sqliteTable(
  'source_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scanRunId: integer('scan_run_id').references(() => scanRuns.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'success', 'failed', 'skipped'] }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    found: integer('found').notNull().default(0),
    newListings: integer('new_listings').notNull().default(0),
    newJobs: integer('new_jobs').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    expired: integer('expired').notNull().default(0),
    parseErrors: integer('parse_errors').notNull().default(0),
    errorCode: text('error_code'),
    error: text('error'),
  },
  (t) => [index('source_runs_source_idx').on(t.sourceId, t.startedAt)],
);

export const JOB_STATUSES = ['active', 'expired'] as const;

/** A canonical job: one real opportunity, possibly listed on several sources. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fingerprint: text('fingerprint').notNull(),
    companyKey: text('company_key').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    workMode: text('work_mode', { enum: ['remote', 'hybrid', 'onsite'] }),
    employmentType: text('employment_type'),
    salaryMin: real('salary_min'),
    salaryMax: real('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: text('salary_period'),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastChangedAt: integer('last_changed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('jobs_fingerprint_idx').on(t.fingerprint), index('jobs_company_idx').on(t.companyKey), index('jobs_first_seen_idx').on(t.firstSeenAt)],
);

/** One appearance of a job on one source. Separate applications per listing are allowed (PRD §13, §30). */
export const jobListings = sqliteTable(
  'job_listings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceJobId: text('source_job_id').notNull(),
    sourceUrl: text('source_url').notNull(),
    applicationUrl: text('application_url'),
    applyEmail: text('apply_email'),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    workMode: text('work_mode', { enum: ['remote', 'hybrid', 'onsite'] }),
    employmentType: text('employment_type'),
    salaryText: text('salary_text'),
    description: text('description').notNull(),
    descriptionHash: text('description_hash').notNull(),
    postedAt: integer('posted_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    missedRuns: integer('missed_runs').notNull().default(0),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastChangedAt: integer('last_changed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('job_listings_source_job_uq').on(t.sourceId, t.sourceJobId),
    index('job_listings_job_idx').on(t.jobId),
  ],
);

/** JD requirement analysis, cached per description so each description is analysed once. */
export const jobAnalyses = sqliteTable('job_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  descriptionHash: text('description_hash').notNull().unique(),
  requirements: text('requirements', { mode: 'json' }).$type<unknown>().notNull(),
  method: text('method', { enum: ['ai', 'heuristic'] }).notNull(),
  model: text('model'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const REVIEW_STATES = ['NEW', 'VIEWED', 'APPROVED', 'SKIPPED'] as const;

/** A profile's view of a job: score, decision and the user's review state (PRD §19, §29). */
export const matches = sqliteTable(
  'matches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    breakdown: text('breakdown', { mode: 'json' }).$type<unknown>().notNull(),
    decision: text('decision', { enum: ['surfaced', 'filtered'] }).notNull(),
    filterReason: text('filter_reason'),
    reviewState: text('review_state', { enum: REVIEW_STATES }).notNull(),
    method: text('method', { enum: ['ai', 'heuristic', 'gate'] }).notNull(),
    sliderValue: integer('slider_value').notNull(),
    /** The job's lastChangedAt and a hash of the profile's data + preferences at evaluation time (re-evaluate when either moves). */
    jobVersion: integer('job_version').notNull(),
    profileVersion: integer('profile_version').notNull(),
    firstSurfacedAt: integer('first_surfaced_at', { mode: 'timestamp_ms' }),
    evaluatedAt: integer('evaluated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('matches_profile_job_uq').on(t.profileId, t.jobId), index('matches_feed_idx').on(t.profileId, t.decision, t.score)],
);

export const APPLICATION_STATUSES = [
  'PREPARING',
  'READY',
  'APPLYING',
  'APPLIED',
  'INTERVIEW',
  'OFFER',
  'PREPARATION_FAILED',
  'APPLICATION_SKIPPED',
  'APPLICATION_FAILED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
] as const;

/**
 * One attempt to apply to one listing of a job, for one profile (PRD §28–30). It keeps a snapshot of what was
 * applied to, so deleting a source or an expired job never deletes the user's application history.
 */
export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    jobId: integer('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    listingId: integer('listing_id').references(() => jobListings.id, { onDelete: 'set null' }),
    matchId: integer('match_id').references(() => matches.id, { onDelete: 'set null' }),
    jobTitle: text('job_title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url').notNull(),
    applicationUrl: text('application_url'),
    applyEmail: text('apply_email'),
    method: text('method', { enum: ['browser', 'email', 'manual'] }).notNull(),
    status: text('status', { enum: APPLICATION_STATUSES }).notNull(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    approvedAt: integer('approved_at', { mode: 'timestamp_ms' }).notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('applications_profile_listing_uq').on(t.profileId, t.listingId), index('applications_status_idx').on(t.status)],
);

export const applicationEvents = sqliteTable(
  'application_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** observed = a fact we saw; ai = an interpretation; user = the user did it; system = Job Scraper did it. */
    origin: text('origin', { enum: ['observed', 'ai', 'user', 'system'] }).notNull(),
    message: text('message').notNull(),
    confidence: real('confidence'),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('application_events_app_idx').on(t.applicationId, t.occurredAt)],
);

export const NOTIFICATION_CHANNELS = ['inapp', 'browser', 'desktop', 'email', 'telegram'] as const;

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event: text('event').notNull(),
    /** What the notification is about, e.g. "match:12" or "digest:2026-10-01T10". Used for de-duplication. */
    entityKey: text('entity_key').notNull(),
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Path inside the app, e.g. "/feed/12". */
    link: text('link'),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] }).notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('notifications_dedupe_uq').on(t.event, t.entityKey, t.channel), index('notifications_inbox_idx').on(t.channel, t.createdAt)],
);

export const DOCUMENT_KINDS = ['tailored_cv_json', 'tailored_cv_pdf', 'tailored_cv_html', 'change_report', 'cover_letter', 'cover_letter_pdf', 'email', 'screenshot', 'attachment'] as const;

/** Files generated for an application (PRD §22, §35). Deleted with the application (N10). */
export const documents = sqliteTable(
  'documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: DOCUMENT_KINDS }).notNull(),
    /** Path inside the data/files directory. */
    path: text('path').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('documents_app_idx').on(t.applicationId, t.kind),
    // One tailored CV, cover letter, email draft… per application (N2); screenshots and attachments may repeat.
    uniqueIndex('documents_app_kind_uq').on(t.applicationId, t.kind).where(sql`${t.kind} not in ('screenshot', 'attachment')`),
  ],
);

export const SENT_EMAIL_STATUSES = ['sending', 'sent', 'failed', 'uncertain'] as const;

/**
 * Application emails sent from the user's account (PRD §24). A row is written before the provider is called, with
 * the Message-ID fixed up front, so a crash mid-send leaves a "sending" row instead of a silent double send.
 */
export const sentEmails = sqliteTable(
  'sent_emails',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    status: text('status', { enum: SENT_EMAIL_STATUSES }).notNull(),
    provider: text('provider').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** Document ids attached (always this application's own documents). */
    attachments: text('attachments', { mode: 'json' }).$type<number[]>().notNull(),
    /** The provider's reply (e.g. "250 2.0.0 OK"), kept as submission evidence. */
    response: text('response'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('sent_emails_message_id_uq').on(t.messageId), index('sent_emails_app_idx').on(t.applicationId, t.createdAt)],
);

export const INBOX_LABELS = ['acknowledgement', 'interview', 'rejection', 'info_request', 'offer', 'other'] as const;

/**
 * Recruiter emails matched to an application (PRD §32). What was seen (from, subject, when) is kept apart from what
 * was interpreted (label, confidence, suggested status). Only matched messages keep any content.
 */
export const inboxMessages = sqliteTable(
  'inbox_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id').references(() => applications.id, { onDelete: 'cascade' }),
    /** Mailbox identity (account + folder), so UIDs from different mailboxes never collide. */
    mailbox: text('mailbox').notNull(),
    uid: integer('uid').notNull(),
    messageId: text('message_id'),
    fromAddress: text('from_address'),
    subject: text('subject'),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }),
    /** First characters of the text (matched messages only). */
    snippet: text('snippet'),
    /** How the message was linked to the application: thread | domain | ats+company | company+title. */
    matchedBy: text('matched_by'),
    label: text('label', { enum: INBOX_LABELS }),
    confidence: real('confidence'),
    /** Who interpreted it: ai (a model) or rules (offline keyword rules, a rough guess). */
    method: text('method', { enum: ['ai', 'rules'] }),
    /** The status this message suggests (when it wasn't applied automatically). */
    suggestedStatus: text('suggested_status', { enum: APPLICATION_STATUSES }),
    /** applied | dismissed | auto | obsolete (what happened to the suggestion). */
    resolution: text('resolution'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('inbox_messages_mailbox_uid_uq').on(t.mailbox, t.uid), index('inbox_messages_app_idx').on(t.applicationId)],
);
