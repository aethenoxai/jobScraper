/** Minimal Telegram Bot API client (sendMessage, editMessageText, answerCallbackQuery, getUpdates). */
import { registerSecret, scrubSecrets } from '../../logging';

export class TelegramError extends Error {
  override name = 'TelegramError';
  constructor(
    message: string,
    readonly code: number | null = null,
    /** Seconds Telegram asked us to wait (rate limits). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

export interface Button {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number | string }; text?: string };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number | string }; text?: string } };
}

export function createTelegramClient(deps: { token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  registerSecret(deps.token);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = `https://api.telegram.org/bot${deps.token}`;

  async function call<T>(method: string, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? deps.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      // Network errors can echo the URL, which contains the token.
      throw new TelegramError(`Telegram is unreachable: ${scrubSecrets((err as Error).message).replaceAll(deps.token, '[REDACTED]')}`);
    }
    const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!data.ok) throw new TelegramError(`Telegram ${method} failed: ${data.description ?? 'unknown error'}`, data.error_code ?? res.status, data.parameters?.retry_after ?? null);
    return data.result as T;
  }

  const keyboard = (rows?: Button[][]) =>
    rows ? { reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData }))) } } : {};

  return {
    /** The bot's numeric id (the part of the token before ":"); not secret. */
    botId: deps.token.split(':')[0],
    async sendMessage(chatId: string | number, text: string, buttons?: Button[][]): Promise<number> {
      const r = await call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, ...keyboard(buttons), disable_web_page_preview: true });
      return r.message_id;
    },
    async editMessageText(chatId: string | number, messageId: number, text: string, buttons?: Button[][]): Promise<void> {
      await call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...keyboard(buttons), disable_web_page_preview: true });
    },
    async answerCallbackQuery(id: string, text?: string): Promise<void> {
      await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
    },
    /** Long-polls for new messages and button presses. */
    async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
      return call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, { signal, timeoutMs: (timeoutSec + 15) * 1000 });
    },
  };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;
