import { CHATGPT_RETURN_KEY, startChatGptSignIn } from '@/server/ai/chatgpt-auth';
import { getAppContext } from '@/server/context';

export const dynamic = 'force-dynamic';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/** Sends the browser to OpenAI to sign in with ChatGPT (the redirect must be http://127.0.0.1:<port>/callback). */
export async function GET(req: Request) {
  const { settings, config } = getAppContext();
  const origin = new URL(req.url).origin;
  const back = new URL(req.url).searchParams.get('from') === 'settings' ? '/settings/ai' : '/welcome';
  settings.set(CHATGPT_RETURN_KEY, back);
  if (!LOOPBACK.has(config.host)) {
    const message = 'Sign in with ChatGPT works only when Job Scraper is opened on this computer at http://127.0.0.1 (OpenAI allows only that address).';
    return Response.redirect(`${origin}${back}?error=${encodeURIComponent(message)}`, 302);
  }
  return Response.redirect(startChatGptSignIn(settings, `http://127.0.0.1:${config.port}/callback`), 302);
}
