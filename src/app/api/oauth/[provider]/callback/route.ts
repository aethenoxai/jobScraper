import { getAppContext } from '@/server/context';
import type { Config } from '@/server/config';

/** The address registered with Google/Microsoft: the configured host and port, not whatever the browser used. */
const appOrigin = (c: Config) => `http://${c.host === '0.0.0.0' ? '127.0.0.1' : c.host}:${c.port}`;
import { completeOAuth, OAUTH_PROVIDERS, type OAuthProvider } from '@/server/email/oauth';
import { isNamedError } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** The provider sends the browser back here with a one-time code, checked against the state we started with. */
export async function GET(req: Request, ctx: RouteContext<'/api/oauth/[provider]/callback'>) {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) return new Response('Unknown provider', { status: 404 });
  const { settings, log, config } = getAppContext();
  try {
    const account = await completeOAuth(
      settings,
      provider as OAuthProvider,
      { code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error_description') ?? url.searchParams.get('error') },
      process.env,
      `${appOrigin(config)}/api/oauth/${provider}/callback`,
    );
    return Response.redirect(`${url.origin}/settings/email?connected=${encodeURIComponent(account.email)}`, 302);
  } catch (err) {
    if (!isNamedError(err, 'OAuthError')) log.error({ err, provider }, 'email account connection failed');
    const message = isNamedError(err, 'OAuthError') ? err.message : 'Connecting the account failed. Try again.';
    return Response.redirect(`${url.origin}/settings/email?error=${encodeURIComponent(message)}`, 302);
  }
}
