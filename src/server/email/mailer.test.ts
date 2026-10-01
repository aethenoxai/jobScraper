import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../tests/helpers/temp-db';
import { PermanentError } from '../queue';
import { createSettings } from '../settings';
import { createMailer, smtpStatus } from './mailer';
import { EMAIL_SETTINGS_KEY } from './oauth';

let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

describe('mailer', () => {
  it('reports what is missing from the SMTP settings', () => {
    expect(smtpStatus({})).toMatchObject({ ok: false });
    expect(smtpStatus({}).reason).toMatch(/SMTP_HOST/);
    expect(smtpStatus({ SMTP_HOST: 'smtp.example.com', SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'secret-pass' })).toEqual({ ok: true, reason: null, from: 'me@example.com' });
  });

  it('sends mail with attachments through the transport', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const mailer = createMailer({ env: { SMTP_HOST: 'x', SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'p4ssword' }, transport });
    const r = await mailer.send({ to: 'hr@company.example', subject: 'Application', text: 'Hello', attachments: [{ filename: 'cv.pdf', content: Buffer.from('%PDF') }] });
    const sent = JSON.parse(r.raw);
    expect(sent).toMatchObject({ from: { address: 'me@example.com' }, to: [{ address: 'hr@company.example' }], subject: 'Application' });
    expect(sent.attachments[0].filename).toBe('cv.pdf');
    expect(r.messageId).toBeTruthy();
  });

  it('refuses to send without configuration', async () => {
    await expect(createMailer({ env: {} }).send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/SMTP_HOST/);
  });
});

describe('mailer providers', () => {
  const smtpEnv = { SMTP_HOST: 'x', SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'p4ssword' };

  it('asks to reconnect when the provider ended the sign-in', () => {
    const settings = createSettings(t.db);
    settings.set(EMAIL_SETTINGS_KEY, { provider: 'gmail' });
    settings.set('email.oauth.gmail', { email: 'a@gmail.com', refreshToken: 'rt', connectedAt: 1, needsReconnect: true });
    expect(createMailer({ env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's' }, settings }).status()).toMatchObject({ ok: false, reason: expect.stringMatching(/Reconnect your Gmail account/) });
  });

  it('says what to do when Gmail is chosen but not connected', () => {
    const settings = createSettings(t.db);
    settings.set(EMAIL_SETTINGS_KEY, { provider: 'gmail' });
    const m = createMailer({ env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's' }, settings });
    expect(m.status()).toMatchObject({ ok: false, provider: 'gmail', reason: expect.stringMatching(/Connect your Gmail account/) });
  });

  it('sends through Gmail with OAuth2 as the connected address', async () => {
    const settings = createSettings(t.db);
    settings.set(EMAIL_SETTINGS_KEY, { provider: 'gmail' });
    settings.set('email.oauth.gmail', { email: 'asha@gmail.com', refreshToken: 'rt-1', connectedAt: 1 });
    const seen: unknown[] = [];
    const m = createMailer({ env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's' }, settings, transportFactory: (o) => (seen.push(o), nodemailer.createTransport({ jsonTransport: true })) });
    expect(m.status()).toMatchObject({ ok: true, provider: 'gmail', from: 'asha@gmail.com' });
    const r = await m.send({ to: 'hr@company.example', subject: 's', text: 't', messageId: '<fixed-1@job-scraper.local>' });
    expect(seen[0]).toMatchObject({ host: 'smtp.gmail.com', auth: { type: 'OAuth2', user: 'asha@gmail.com', provisionCallback: expect.any(Function) } });
    expect(r).toMatchObject({ messageId: '<fixed-1@job-scraper.local>', provider: 'gmail', from: 'asha@gmail.com' });
    expect(JSON.parse(r.raw).messageId).toBe('<fixed-1@job-scraper.local>');
  });

  it('reports accepted and rejected recipients and the server reply as evidence', async () => {
    const transport = { sendMail: async () => ({ messageId: '<m@x>', accepted: ['hr@company.example'], rejected: [], response: '250 2.0.0 OK queued', message: '' }) } as never;
    const r = await createMailer({ env: smtpEnv, transport }).send({ to: 'hr@company.example', subject: 's', text: 't' });
    expect(r).toMatchObject({ accepted: ['hr@company.example'], rejected: [], response: '250 2.0.0 OK queued' });
  });

  it('treats a failed sign-in or a rejected recipient as permanent, with a hint', async () => {
    const failing = (err: Error & { code?: string; responseCode?: number }) => ({ sendMail: async () => Promise.reject(err) }) as never;
    const auth = Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    await expect(createMailer({ env: smtpEnv, transport: failing(auth) }).send({ to: 'a@b.example', subject: 's', text: 't' })).rejects.toThrow(PermanentError);
    await expect(createMailer({ env: smtpEnv, transport: failing(auth) }).send({ to: 'a@b.example', subject: 's', text: 't' })).rejects.toThrow(/app password/);
    const rcpt = Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 No such user'), { code: 'EENVELOPE', responseCode: 550 });
    await expect(createMailer({ env: smtpEnv, transport: failing(rcpt) }).send({ to: 'a@b.example', subject: 's', text: 't' })).rejects.toThrow(/rejected/);
    const net = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    const e = await createMailer({ env: smtpEnv, transport: failing(net) }).send({ to: 'a@b.example', subject: 's', text: 't' }).catch((x) => x);
    expect(e).not.toBeInstanceOf(PermanentError);
  });
});

describe('local mail servers', () => {
  it('accepts a self-signed certificate only when SMTP_ALLOW_SELF_SIGNED=true', async () => {
    const seen: Array<{ tls?: { rejectUnauthorized?: boolean }; requireTLS?: boolean }> = [];
    const factory = (o: unknown) => (seen.push(o as never), nodemailer.createTransport({ jsonTransport: true }));
    const env = { SMTP_HOST: 'localhost', SMTP_USERNAME: 'me@example.com', SMTP_PASSWORD: 'p4ssword' };
    await createMailer({ env, transportFactory: factory }).send({ to: 'a@b.example', subject: 's', text: 't' });
    await createMailer({ env: { ...env, SMTP_ALLOW_SELF_SIGNED: 'true' }, transportFactory: factory }).send({ to: 'a@b.example', subject: 's', text: 't' });
    expect(seen[0].tls).toBeUndefined();
    expect(seen[1]).toMatchObject({ requireTLS: true, tls: { rejectUnauthorized: false } });
  });
});

describe('sender problems the user can fix', () => {
  it('needs a real From address (SendGrid-style usernames are not one)', () => {
    expect(smtpStatus({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_USERNAME: 'apikey', SMTP_PASSWORD: 'x' })).toMatchObject({ ok: false, reason: expect.stringMatching(/SMTP_FROM/) });
    expect(smtpStatus({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_USERNAME: 'apikey', SMTP_PASSWORD: 'x', SMTP_FROM: 'Asha Rao <asha@example.com>' })).toMatchObject({ ok: true, from: 'Asha Rao <asha@example.com>' });
  });

  it('explains Microsoft 365 accounts where SMTP sign-in is switched off', async () => {
    const err = Object.assign(new Error('Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.'), { code: 'EAUTH', responseCode: 535 });
    const transport = { sendMail: async () => Promise.reject(err) } as never;
    await expect(createMailer({ env: { SMTP_HOST: 'smtp.office365.com', SMTP_USERNAME: 'a@b.example', SMTP_PASSWORD: 'p' }, transport }).send({ to: 'x@y.example', subject: 's', text: 't' })).rejects.toThrow(/SMTP sign-in is turned off/);
  });
});
