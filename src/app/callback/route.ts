import { CHATGPT_RETURN_KEY, ChatGptReturnSchema, chatGptReturnAddress, finishChatGptSignIn } from '@/server/ai/chatgpt-auth';
import { getAppContext } from '@/server/context';
import { isNamedError } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** OpenAI sends the browser back here after "Sign in with ChatGPT" (the only redirect address it accepts). */
export async function GET(req: Request) {
  const { settings, config, log } = getAppContext();
  const url = new URL(req.url);
  const back = settings.get(CHATGPT_RETURN_KEY, ChatGptReturnSchema, null) ?? '/welcome';
  const q = (k: string) => url.searchParams.get(k);
  try {
    await finishChatGptSignIn(settings, { code: q('code'), state: q('state'), error: q('error'), client_id: q('client_id'), scope: q('scope') }, `http://127.0.0.1:${config.port}/callback`);
    return Response.redirect(chatGptReturnAddress(url.origin, back, { chatgpt: 'connected' }), 302);
  } catch (err) {
    if (!isNamedError(err, 'ChatGptSignInError')) log.error({ err }, 'Sign in with ChatGPT failed');
    const message = isNamedError(err, 'ChatGptSignInError') ? err.message : 'Signing in with ChatGPT failed. Check the logs for details.';
    return Response.redirect(chatGptReturnAddress(url.origin, back, { error: message }), 302);
  }
}
