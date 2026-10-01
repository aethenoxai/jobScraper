import { getAppContext } from '@/server/context';
import type { Config } from '@/server/config';

/** The address registered with Google/Microsoft: the configured host and port, not whatever the browser used. */
const appOrigin = (c: Config) => `http://${c.host === '0.0.0.0' ? '127.0.0.1' : c.host}:${c.port}`;
import { OAUTH_PROVIDERS, startOAuth, type OAuthProvider } from '@/server/email/oauth';

export const dynamic = 'force-dynamic';

/** Sends the browser to Google/Microsoft to connect an account for sending applications. */
export async function GET(req: Request, ctx: RouteContext<'/api/oauth/[provider]/start'>) {
  const { provider } = await ctx.params;
  const origin = new URL(req.url).origin;
  if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) return new Response('Unknown provider', { status: 404 });
  try {
    const { settings, config } = getAppContext();
    const url = startOAuth(settings, provider as OAuthProvider, process.env, `${appOrigin(config)}/api/oauth/${provider}/callback`);
    return Response.redirect(url, 302);
  } catch (err) {
    return Response.redirect(`${origin}/settings/email?error=${encodeURIComponent((err as Error).message)}`, 302);
  }
}
