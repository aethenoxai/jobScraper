import type { Metadata } from 'next';
import { EmailTestButton } from '@/components/settings/email-test-button';
import { btn, btnPrimary, Card, Notice, PageHeader } from '@/components/ui';
import { getAppContext } from '@/server/context';
import { createMailer, smtpStatus } from '@/server/email/mailer';
import { clientConfig, connectedAccount, DEFAULT_EMAIL_SETTINGS, EMAIL_SETTINGS_KEY, EmailSettingsSchema, OAUTH_PROVIDERS, PROVIDERS } from '@/server/email/oauth';
import { disconnectEmailAction, setEmailProviderAction } from './actions';

export const metadata: Metadata = { title: 'Email settings' };

export const dynamic = 'force-dynamic';

export default async function EmailSettingsPage({ searchParams }: PageProps<'/settings/email'>) {
  const sp = (await searchParams) as { connected?: string; error?: string };
  const { settings, config } = getAppContext();
  // The address registered with Microsoft must be the one this app answers on (its HOST and PORT).
  const origin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  const env = process.env;
  const current = settings.get(EMAIL_SETTINGS_KEY, EmailSettingsSchema, DEFAULT_EMAIL_SETTINGS).provider;
  const status = createMailer({ env, settings }).status();
  const smtp = smtpStatus(env);
  const oauth = OAUTH_PROVIDERS.map((p) => {
    let setup: string | null = null;
    try {
      clientConfig(p, env);
    } catch (err) {
      setup = (err as Error).message;
    }
    return { p, label: PROVIDERS[p].label, setup, account: connectedAccount(settings, p) };
  });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Email" subtitle="The account Job Scraper sends your applications (and email notifications) from. Nothing is sent until you press Send." />
      {sp.connected && <Notice tone="green">Connected {sp.connected}.</Notice>}
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      <Card title="Send from">
        <form action={setEmailProviderAction} className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="provider" value="smtp" defaultChecked={current === 'smtp'} />
            <span><b>SMTP</b> (any provider; Gmail and Outlook work with an app password) — {smtp.ok ? `sending as ${smtp.from}` : smtp.reason}</span>
          </label>
          {oauth.map((o) => (
            <label key={o.p} className="flex items-start gap-2">
              <input type="radio" name="provider" value={o.p} defaultChecked={current === o.p} disabled={!o.account} />
              <span><b>{o.label}</b> — {o.account ? (o.account.needsReconnect ? `${o.account.email}: ${o.label} ended the sign-in, connect again below` : `connected as ${o.account.email}`) : o.setup ?? 'not connected yet'}</span>
            </label>
          ))}
          <button className={btnPrimary}>Save</button>
        </form>
        <p className="mt-3 text-sm" data-testid="email-status">{status.ok ? `Ready: sending as ${status.from} via ${status.provider}.` : `Not ready: ${status.reason}`}</p>
        <div className="mt-3"><EmailTestButton /></div>
      </Card>
      {oauth.map((o) => (
        <Card key={o.p} title={`Connect ${o.label}`}>
          <div className="space-y-2 text-sm">
            {o.account && !o.account.needsReconnect ? (
              <form action={disconnectEmailAction.bind(null, o.p)} className="flex items-center gap-3">
                <span>Connected as {o.account.email}.</span>
                <button className={btn}>Disconnect</button>
              </form>
            ) : o.setup ? (
              <p>{o.setup}</p>
            ) : (
              <a href={`/api/oauth/${o.p}/start`} className={btn}>Connect {o.label}</a>
            )}
            <p className="text-neutral-500">
              {o.p === 'gmail'
                ? 'Create an OAuth client of type “Desktop app” in Google Cloud Console (Gmail API scope), then add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to .env. See docs/setup/email.md.'
                : `Register an app in Microsoft Entra (personal and work accounts, redirect ${origin}/api/oauth/outlook/callback, SMTP.Send and IMAP.AccessAsUser.All permissions), then add OUTLOOK_CLIENT_ID to .env. See docs/setup/email.md.`}
            </p>
          </div>
        </Card>
      ))}
    </div>
  );
}
