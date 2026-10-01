import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { EMAIL_SETTINGS_KEY } from '../email/oauth';
import { createSettings } from '../settings';
import { mailboxConfig, parseMessage } from './mailbox';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('parseMessage', () => {
  it('reads sender, subject, thread headers and plain text (from HTML too)', async () => {
    const raw = [
      'From: "Acme Talent" <talent@acme.example>',
      'To: asha@example.com',
      'Subject: =?UTF-8?Q?Interview_invitation_=E2=80=93_Backend_Engineer?=',
      'Message-ID: <reply-1@acme.example>',
      'In-Reply-To: <app-1@example.com>',
      'References: <app-1@example.com> <x@acme.example>',
      'Date: Tue, 01 Oct 2026 10:00:00 +0000',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hi Asha,</p><p>We would like to invite you to an <b>interview</b>.</p>',
    ].join('\r\n');
    const m = await parseMessage(Buffer.from(raw));
    expect(m).toMatchObject({ from: 'talent@acme.example', fromName: 'Acme Talent', subject: 'Interview invitation – Backend Engineer', messageId: '<reply-1@acme.example>', inReplyTo: '<app-1@example.com>', references: ['<app-1@example.com>', '<x@acme.example>'] });
    expect(m.text).toMatch(/invite you to an interview/);
  });
});

describe('mailboxConfig', () => {
  it('uses the SMTP account’s matching IMAP server, or IMAP_* settings', () => {
    const settings = createSettings(t.db);
    expect(mailboxConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_USERNAME: 'a@gmail.com', SMTP_PASSWORD: 'app-pass' }, settings)).toMatchObject({ host: 'imap.gmail.com', port: 993, secure: true, user: 'a@gmail.com' });
    expect(mailboxConfig({ IMAP_HOST: 'mail.example.com', IMAP_PORT: '143', IMAP_USERNAME: 'me', IMAP_PASSWORD: 'x' }, settings)).toMatchObject({ host: 'mail.example.com', port: 143, secure: false, user: 'me' });
  });

  it('says what is missing', () => {
    expect(mailboxConfig({ SMTP_HOST: 'smtp.unknown.example', SMTP_USERNAME: 'a', SMTP_PASSWORD: 'b' }, createSettings(t.db))).toMatchObject({ error: expect.stringMatching(/IMAP_HOST/) });
  });

  it('uses the connected Gmail account (OAuth) when Gmail is the sender', () => {
    const settings = createSettings(t.db);
    settings.set(EMAIL_SETTINGS_KEY, { provider: 'gmail' });
    settings.set('email.oauth.gmail', { email: 'a@gmail.com', refreshToken: 'rt', connectedAt: 1 });
    expect(mailboxConfig({ GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's' }, settings)).toMatchObject({ host: 'imap.gmail.com', user: 'a@gmail.com', oauth: 'gmail' });
  });

  it('asks to reconnect an Outlook account that was connected for sending only (M8 review I1)', () => {
    const settings = createSettings(t.db);
    settings.set(EMAIL_SETTINGS_KEY, { provider: 'outlook' });
    settings.set('email.oauth.outlook', { email: 'me@outlook.com', refreshToken: 'rt', connectedAt: 1 });
    expect(mailboxConfig({ OUTLOOK_CLIENT_ID: 'id' }, settings)).toMatchObject({ error: expect.stringMatching(/Reconnect Outlook.*read replies/) });
  });

  it('IMAP settings stand on their own: own password, own self-signed switch (M8 review minors 5, 6)', () => {
    const settings = createSettings(t.db);
    const base = { SMTP_HOST: 'smtp.example.com', SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'smtp-pass', SMTP_ALLOW_SELF_SIGNED: 'true', IMAP_HOST: 'imap.other.example' };
    expect(mailboxConfig(base, settings)).toMatchObject({ allowSelfSigned: false, user: 'me@example.com', password: 'smtp-pass' });
    expect(mailboxConfig({ ...base, IMAP_ALLOW_SELF_SIGNED: 'true' }, settings)).toMatchObject({ allowSelfSigned: true });
    // A different IMAP user must come with its own password, never the SMTP account's.
    expect(mailboxConfig({ ...base, IMAP_USERNAME: 'other@example.com' }, settings)).toMatchObject({ error: expect.stringMatching(/IMAP_PASSWORD/) });
  });
});
