/**
 * Reads the user's inbox over IMAP for tracking (PRD §32): the connected Gmail/Outlook account (OAuth), or IMAP
 * settings (by default the SMTP account's own IMAP server). Only envelopes are read for every new message; the
 * text is fetched only for messages that could belong to an application.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { canReadInbox, connectedAccount, DEFAULT_EMAIL_SETTINGS, EMAIL_SETTINGS_KEY, EmailSettingsSchema, refreshAccessToken, type OAuthProvider } from '../email/oauth';
import { registerSecret } from '../logging';
import type { SettingsStore } from '../settings';

export interface MailboxConfig {
  /** Identifies the mailbox in stored state ("imap.gmail.com/a@gmail.com/INBOX"). */
  id: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  oauth?: OAuthProvider;
  allowSelfSigned?: boolean;
}

/** Set on mail Job Scraper sends to the user (notifications), so tracking never reads its own messages. */
export const AUTOMATED_HEADER = 'X-Job-Scraper';

export interface Envelope {
  uid: number;
  /** Carries the X-Job-Scraper header (sent by Job Scraper itself). */
  automated?: boolean;
  messageId: string | null;
  from: string;
  fromName: string;
  subject: string;
  date: Date | null;
  inReplyTo: string | null;
  references: string[];
}

export interface ParsedMessage extends Omit<Envelope, 'uid'> {
  text: string;
}

/** IMAP servers of common providers, keyed by their SMTP host. */
const IMAP_FOR_SMTP: Record<string, string> = {
  'smtp.gmail.com': 'imap.gmail.com',
  'smtp-mail.outlook.com': 'outlook.office365.com',
  'smtp.office365.com': 'outlook.office365.com',
  'smtp.mail.me.com': 'imap.mail.me.com',
  'smtp.fastmail.com': 'imap.fastmail.com',
  'smtp.zoho.com': 'imap.zoho.com',
  'smtp.zoho.in': 'imap.zoho.in',
  'smtp.mail.yahoo.com': 'imap.mail.yahoo.com',
};
const OAUTH_IMAP: Record<OAuthProvider, string> = { gmail: 'imap.gmail.com', outlook: 'outlook.office365.com' };

export function mailboxConfig(env: Record<string, string | undefined>, settings: SettingsStore): MailboxConfig | { error: string } {
  const provider = settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, DEFAULT_EMAIL_SETTINGS).provider;
  if (provider !== 'smtp') {
    const account = connectedAccount(settings, provider);
    if (!account) return { error: `Connect your ${provider === 'gmail' ? 'Gmail' : 'Outlook'} account in Settings → Email first.` };
    if (!canReadInbox(account, provider)) return { error: `Reconnect ${provider === 'gmail' ? 'Gmail' : 'Outlook'} in Settings → Email to allow Job Scraper to read replies (it was connected for sending only).` };
    return { id: `${OAUTH_IMAP[provider]}/${account.email}/INBOX`, host: OAUTH_IMAP[provider], port: 993, secure: true, user: account.email, oauth: provider };
  }
  const host = env.IMAP_HOST?.trim() || IMAP_FOR_SMTP[(env.SMTP_HOST ?? '').trim().toLowerCase()];
  const ownUser = env.IMAP_USERNAME?.trim();
  const user = ownUser || env.SMTP_USERNAME?.trim();
  // A separate IMAP account needs its own password; the SMTP password is only reused for the same account.
  const password = env.IMAP_PASSWORD || (!ownUser || ownUser === env.SMTP_USERNAME?.trim() ? env.SMTP_PASSWORD : undefined);
  if (!host) return { error: 'Add IMAP_HOST (and IMAP_USERNAME / IMAP_PASSWORD if they differ from SMTP) to your .env file to read replies.' };
  if (!user || !password) return { error: ownUser ? 'Add IMAP_PASSWORD for IMAP_USERNAME to your .env file.' : 'Add IMAP_USERNAME and IMAP_PASSWORD (or SMTP_USERNAME and SMTP_PASSWORD) to your .env file.' };
  registerSecret(password);
  const port = Number(env.IMAP_PORT || 993);
  return { id: `${host}/${user}/INBOX`, host, port, secure: env.IMAP_SECURE ? env.IMAP_SECURE === 'true' : port === 993, user, password, allowSelfSigned: env.IMAP_ALLOW_SELF_SIGNED === 'true' };
}

const MAX_SOURCE_BYTES = 512 * 1024;

/** "References: <a>\r\n <b>\r\nX-Job-Scraper: notification" → name (lower case) → unfolded value. */
export function headerMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);

/** Parses a raw message into what tracking needs; HTML-only mail is reduced to text. */
export async function parseMessage(source: Buffer): Promise<ParsedMessage> {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = m.from?.value[0];
  const text = (m.text ?? (typeof m.html === 'string' ? m.html.replace(/<[^>]+>/g, ' ') : '')).replace(/\s+/g, ' ').trim();
  return {
    messageId: m.messageId ?? null,
    from: (from?.address ?? '').toLowerCase(),
    fromName: from?.name ?? '',
    subject: m.subject ?? '',
    date: m.date ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: ids(m.references),
    text: text.slice(0, 4000),
  };
}

export interface MailboxSession {
  /** Changes when the server renumbers the mailbox; stored UIDs are only valid with the same value. */
  uidValidity: string;
  /** New messages after `afterUid` (or received since `since` on the first run), envelopes only. */
  envelopes(afterUid: number | null, since: Date): Promise<{ envelopes: Envelope[] }>;
  /** The text of one message. */
  read(uid: number): Promise<ParsedMessage>;
  close(): Promise<void>;
}

export async function openMailbox(cfg: MailboxConfig, deps: { env: Record<string, string | undefined>; settings: SettingsStore }): Promise<MailboxSession> {
  const auth = cfg.oauth ? { user: cfg.user, accessToken: (await refreshAccessToken(deps.settings, cfg.oauth, deps.env)).accessToken } : { user: cfg.user, pass: cfg.password! };
  // Without TLS from the start, STARTTLS is required: the password never goes over a plain connection.
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, doSTARTTLS: cfg.secure ? undefined : true, auth, logger: false, tls: cfg.allowSelfSigned ? { rejectUnauthorized: false } : undefined, socketTimeout: 60_000 });
  await client.connect();
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
  try {
    lock = await client.getMailboxLock('INBOX', { readOnly: true });
  } catch (err) {
    await client.logout().catch(() => client.close());
    throw err;
  }
  const uidValidity = String((client.mailbox && typeof client.mailbox === 'object' && 'uidValidity' in client.mailbox ? client.mailbox.uidValidity : '') ?? '');
  return {
    uidValidity,
    async envelopes(afterUid, since) {
      const out: Envelope[] = [];
      const range = afterUid ? { uid: `${afterUid + 1}:*` } : { since };
      for await (const msg of client.fetch(range, { uid: true, envelope: true, headers: ['references', AUTOMATED_HEADER.toLowerCase()] }, { uid: true })) {
        if (afterUid && msg.uid <= afterUid) continue; // "n:*" always returns the last message
        const env = msg.envelope;
        const headers = headerMap(msg.headers?.toString('utf8') ?? '');
        out.push({
          uid: msg.uid,
          automated: headers.has(AUTOMATED_HEADER.toLowerCase()),
          messageId: env?.messageId ?? null,
          from: (env?.from?.[0]?.address ?? '').toLowerCase(),
          fromName: env?.from?.[0]?.name ?? '',
          subject: env?.subject ?? '',
          date: env?.date ? new Date(env.date) : null,
          inReplyTo: env?.inReplyTo ?? null,
          references: ids(headers.get('references') ?? ''),
        });
      }
      return { envelopes: out };
    },
    async read(uid) {
      // The text comes first in a message; large attachments (offer-letter PDFs) are not downloaded whole.
      const msg = await client.fetchOne(String(uid), { source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
      if (!msg || !msg.source) throw new Error(`Message ${uid} is gone`);
      return parseMessage(msg.source);
    },
    async close() {
      lock.release();
      await client.logout().catch(() => client.close());
    },
  };
}
