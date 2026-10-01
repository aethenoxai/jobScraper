/**
 * The inbox.poll task: reads new inbox messages, links the ones about an application, interprets them and
 * suggests (or, if enabled, applies) a status. Messages that can't be about an application are never opened.
 */
import type { Ai } from '../ai';
import type { ApplicationService } from '../applications/service';
import type { Logger } from '../logging';
import { scrubSecrets } from '../logging';
import type { Notifier } from '../notifications/dispatcher';
import type { TaskHandler } from '../queue/runner';
import type { SettingsStore } from '../settings';
import { classifyMessage } from './classify';
import { mailboxConfig, openMailbox as openImap, type Envelope, type MailboxConfig, type MailboxSession } from './mailbox';
import { couldBelong, matchMessage } from './match';
import type { TrackingService } from './service';

export const INBOX_POLL_TASK = 'inbox.poll';
const FIRST_RUN_DAYS = 30;
const NOTIFY_LABELS = new Set(['interview', 'offer', 'rejection', 'info_request']);
/** A message that keeps failing to load is tried this many times (one per poll), then skipped. */
const MAX_MESSAGE_ATTEMPTS = 3;

export interface PollDeps {
  tracking: TrackingService;
  apps: ApplicationService;
  ai: Ai | null;
  notifier: Notifier;
  settings: SettingsStore;
  env: Record<string, string | undefined>;
  log: Logger;
  now?: () => Date;
  openMailbox?: (cfg: MailboxConfig) => Promise<MailboxSession>;
}

export function createInboxPollHandler(deps: PollDeps): TaskHandler {
  const now = deps.now ?? (() => new Date());
  const open = deps.openMailbox ?? ((cfg: MailboxConfig) => openImap(cfg, { env: deps.env, settings: deps.settings }));
  return async (_payload, ctx) => {
    if (!deps.tracking.settings().inboxEnabled) return;
    const cfg = mailboxConfig(deps.env, deps.settings);
    if ('error' in cfg) return deps.tracking.setStatus(false, cfg.error);
    const mailbox = cfg.id;
    const candidates = deps.tracking.candidates();
    // The user's own mail (including Job Scraper's notification emails) is never about an application.
    const own = new Set([cfg.user, deps.env.SMTP_FROM, deps.env.SMTP_USERNAME, deps.notifier.settings().emailTo, ...deps.tracking.ownAddresses()].filter((a): a is string => !!a?.includes('@')).map((a) => a.trim().toLowerCase()));
    let session: MailboxSession | null = null;
    let matched = 0;
    let retrying = 0;
    let skipped = 0;
    let checked = 0;
    try {
      session = await open(cfg);
      const { uidValidity } = session;
      const state = deps.tracking.mailboxState(cfg.id);
      const same = state && state.uidValidity === uidValidity;
      const known = same ? state.lastUid : null;
      let stuck = same ? (state.stuck ?? null) : null;
      // Everything up to the checkpoint is done; a message that fails holds it back so it is tried again next time.
      let checkpoint = known ?? 0;
      let blocked = false;
      const save = () => deps.tracking.setMailboxState(cfg.id, { uidValidity, lastUid: checkpoint, stuck });
      const since = new Date(now().getTime() - FIRST_RUN_DAYS * 86_400_000);
      const { envelopes } = await session.envelopes(known, since);
      for (const env of envelopes.sort((a, b) => a.uid - b.uid)) {
        if (ctx.signal.aborted) break;
        checked++;
        try {
          if (await handle(env, session)) matched++;
        } catch (err) {
          if (ctx.signal.aborted) break; // stopped mid-message: it is done again next time
          const attempts = stuck?.uid === env.uid ? stuck.count + 1 : 1;
          const message = scrubSecrets(err instanceof Error ? err.message : String(err));
          if (attempts < MAX_MESSAGE_ATTEMPTS) {
            retrying++;
            deps.log.warn({ uid: env.uid, attempts, error: message }, 'inbox message failed; will retry');
            if (!blocked) stuck = { uid: env.uid, count: attempts };
            blocked = true;
            continue;
          }
          skipped++;
          deps.log.warn({ uid: env.uid, error: message }, 'inbox message failed repeatedly; skipped');
        }
        if (!blocked) {
          checkpoint = env.uid;
          if (stuck && stuck.uid <= checkpoint) stuck = null;
          save();
        }
      }
      save();
      const summary = `Checked ${checked} new message(s); ${matched} about your applications.`;
      if (skipped) deps.tracking.setStatus(false, `${summary} Skipped ${skipped} message(s) that couldn't be read.`);
      else deps.tracking.setStatus(true, retrying ? `${summary} ${retrying} message(s) couldn't be read and will be tried again.` : summary);
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err));
      deps.tracking.setStatus(false, `Couldn't read the inbox: ${message}`);
      deps.log.warn({ error: message }, 'inbox poll failed');
    } finally {
      await session?.close().catch(() => {});
    }

    /** Reads, links, interprets and records one message. Returns whether it was about an application. */
    async function handle(env: Envelope, box: MailboxSession): Promise<boolean> {
      if (!candidates.length || env.automated || own.has(env.from.trim().toLowerCase())) return false;
      if (deps.tracking.seen(mailbox, env.uid) || deps.tracking.seenMessageId(env.messageId) || !couldBelong(env, candidates)) return false;
      const msg = await box.read(env.uid);
      if (msg.automated || deps.tracking.seenMessageId(msg.messageId)) return false;
      const match = matchMessage(msg, candidates);
      if (!match) return false;
      const classification = await classifyMessage(msg, deps.ai, ctx.signal);
      // A newsletter from the company's domain is not news about the application.
      if (classification.label === 'other' && match.matchedBy !== 'thread') return false;
      const row = deps.tracking.record({ mailbox, uid: env.uid, messageId: msg.messageId, from: msg.from, subject: msg.subject, receivedAt: msg.date, text: msg.text, match, classification });
      if (NOTIFY_LABELS.has(classification.label)) {
        const app = deps.apps.get(match.applicationId)!;
        const what = classification.label.replace('_', ' ');
        const body = row.resolution === 'auto' ? `“${msg.subject}” from ${msg.from}. The status was updated; open the application to check.` : `“${msg.subject}” from ${msg.from}. Open the application to confirm.`;
        deps.notifier.notify('application.reply', `inbox:${row.id}`, { title: `${app.company}: likely ${what}`, body, link: `/applications/${app.id}` });
      }
      return true;
    }
  };
}
