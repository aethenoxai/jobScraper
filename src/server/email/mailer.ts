import nodemailer, { type Transporter } from 'nodemailer';
import { registerSecret } from '../logging';
import { PermanentError } from '../queue';
import type { SettingsStore } from '../settings';
import { clientConfig, connectedAccount, DEFAULT_EMAIL_SETTINGS, EMAIL_SETTINGS_KEY, EmailSettingsSchema, PROVIDERS, refreshAccessToken, type EmailProvider } from './oauth';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  headers?: Record<string, string>;
}

export interface SmtpStatus {
  ok: boolean;
  reason: string | null;
  from: string | null;
}

/** SMTP settings come from .env (PRD §37). Works for Gmail/Outlook app passwords too. */
export function smtpStatus(env: Record<string, string | undefined>): SmtpStatus {
  const missing = ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) return { ok: false, reason: `Add ${missing.join(', ')} to your .env file to send email.`, from: null };
  const from = (env.SMTP_FROM || env.SMTP_USERNAME!).trim();
  // "Name <a@b.example>" or "a@b.example"; a username like SendGrid's "apikey" is not an address.
  if (!/^(?:[^<>]*<\s*)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>?$/.test(from)) return { ok: false, reason: 'Set SMTP_FROM in .env to the email address you send from (your SMTP username is not one).', from: null };
  return { ok: true, reason: null, from };
}

export interface MailerStatus extends SmtpStatus {
  provider: EmailProvider;
}

export interface SendResult {
  messageId: string;
  raw: string;
  provider: EmailProvider;
  from: string;
  /** Recipients the server accepted / rejected, and its reply (e.g. "250 2.0.0 OK"): evidence of submission. */
  accepted: string[];
  rejected: string[];
  response: string;
}

type TransportOptions = Parameters<typeof nodemailer.createTransport>[0];
const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

/** Problems a retry can't fix become PermanentErrors with what to do. */
function classify(err: unknown, provider: EmailProvider): Error {
  const e = err as Error & { code?: string; responseCode?: number };
  if (/5\.7\.139|SmtpClientAuthentication is disabled/i.test(e?.message ?? '')) {
    return new PermanentError('SMTP sign-in is turned off for this Microsoft 365 account. Ask its admin to allow SMTP AUTH for your mailbox, or send with another provider.');
  }
  if (e?.code === 'EAUTH' || e?.responseCode === 535 || e?.responseCode === 534) {
    const hint = provider === 'smtp' ? 'Check SMTP_USERNAME and SMTP_PASSWORD in .env (Gmail and Outlook need an app password).' : `Reconnect your ${provider === 'gmail' ? 'Gmail' : 'Outlook'} account in Settings → Email.`;
    return new PermanentError(`The mail server refused the sign-in: ${e.message}. ${hint}`);
  }
  if (e?.code === 'EENVELOPE' || (e?.responseCode !== undefined && e.responseCode >= 550 && e.responseCode < 560)) {
    return new PermanentError(`The mail server rejected the message: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(err));
}

/**
 * Sends email from the user's own account: SMTP from .env, or Gmail/Outlook connected with OAuth (Settings → Email).
 * The provider is read at send time, so a change in settings applies without a restart.
 */
export function createMailer(deps: { env: Record<string, string | undefined>; settings?: SettingsStore; transport?: Transporter; transportFactory?: (opts: TransportOptions) => Transporter; timeouts?: Partial<typeof TIMEOUTS> }) {
  const timeouts = { ...TIMEOUTS, ...deps.timeouts };
  registerSecret(deps.env.SMTP_PASSWORD);
  const factory = deps.transportFactory ?? ((o: TransportOptions) => nodemailer.createTransport(o));
  const cache = new Map<string, Transporter>();

  const provider = (): EmailProvider => (deps.settings ? deps.settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, DEFAULT_EMAIL_SETTINGS).provider : 'smtp');

  function status(): MailerStatus {
    const p = provider();
    if (p === 'smtp') return { ...smtpStatus(deps.env), provider: p };
    const label = PROVIDERS[p].label;
    try {
      clientConfig(p, deps.env);
    } catch (err) {
      return { ok: false, reason: (err as Error).message, from: null, provider: p };
    }
    const account = deps.settings ? connectedAccount(deps.settings, p) : null;
    if (!account) return { ok: false, reason: `Connect your ${label} account in Settings → Email.`, from: null, provider: p };
    if (account.needsReconnect) return { ok: false, reason: `Reconnect your ${label} account in Settings → Email (${label} ended the sign-in).`, from: account.email, provider: p };
    return { ok: true, reason: null, from: account.email, provider: p };
  }

  function transportFor(p: EmailProvider): Transporter {
    if (deps.transport) return deps.transport;
    if (p === 'smtp') {
      const port = Number(deps.env.SMTP_PORT || 587);
      const secure = deps.env.SMTP_SECURE ? deps.env.SMTP_SECURE === 'true' : port === 465;
      const key = `smtp:${deps.env.SMTP_HOST}:${port}:${deps.env.SMTP_USERNAME}`;
      if (!cache.has(key)) {
        // STARTTLS is required when not using TLS directly, so the password never travels unencrypted.
        // SMTP_ALLOW_SELF_SIGNED is for mail servers on your own network with their own certificate.
        const tls = deps.env.SMTP_ALLOW_SELF_SIGNED === 'true' ? { tls: { rejectUnauthorized: false } } : {};
        cache.set(key, factory({ host: deps.env.SMTP_HOST, port, secure, requireTLS: !secure, auth: { user: deps.env.SMTP_USERNAME, pass: deps.env.SMTP_PASSWORD }, ...timeouts, ...tls }));
      }
      return cache.get(key)!;
    }
    const cfg = PROVIDERS[p];
    clientConfig(p, deps.env);
    const account = connectedAccount(deps.settings!, p)!;
    const key = `${p}:${account.email}:${account.connectedAt}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        factory({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          requireTLS: !cfg.smtp.secure,
          // We fetch access tokens ourselves so rotated refresh tokens are saved (see refreshAccessToken).
          auth: {
            type: 'OAuth2',
            user: account.email,
            provisionCallback: (_user: string, _renew: boolean, cb: (err: Error | null, accessToken?: string, expires?: number) => void) => {
              refreshAccessToken(deps.settings!, p, deps.env).then(
                (t) => cb(null, t.accessToken, t.expires),
                (err: Error) => cb(err.name === 'OAuthError' ? new PermanentError(err.message) : err),
              );
            },
          },
          ...timeouts,
        } as TransportOptions),
      );
    }
    return cache.get(key)!;
  }

  return {
    status,
    async send(mail: OutgoingMail & { messageId?: string }): Promise<SendResult> {
      const s = status();
      if (!s.ok) throw new PermanentError(s.reason!);
      let info: { messageId?: string; message?: unknown; accepted?: unknown[]; rejected?: unknown[]; response?: string };
      try {
        info = await transportFor(s.provider).sendMail({ from: s.from!, ...mail });
      } catch (err) {
        throw classify(err, s.provider);
      }
      const addr = (x: unknown) => (typeof x === 'string' ? x : ((x as { address?: string })?.address ?? String(x)));
      return {
        messageId: String(info.messageId ?? mail.messageId ?? ''),
        raw: typeof info.message === 'string' ? info.message : info.message instanceof Buffer ? info.message.toString('utf8') : String(info.message ?? ''),
        provider: s.provider,
        from: s.from!,
        accepted: (info.accepted ?? []).map(addr),
        rejected: (info.rejected ?? []).map(addr),
        response: info.response ?? '',
      };
    },
  };
}

export type Mailer = ReturnType<typeof createMailer>;
