import { describe, expect, it } from 'vitest';
import { createTelegramClient, TelegramError } from './client';

const TOKEN = '123456:SECRET-TOKEN-VALUE';

function fakeFetch(respond: (method: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url: String(url), body });
    const method = String(url).split('/').pop()!;
    return new Response(JSON.stringify(respond(method, body)), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('telegram client', () => {
  it('sends messages with inline buttons', async () => {
    const f = fakeFetch(() => ({ ok: true, result: { message_id: 42 } }));
    const tg = createTelegramClient({ token: TOKEN, fetchImpl: f.impl });
    const id = await tg.sendMessage('777', 'New job', [[{ text: 'Approve', callbackData: 'a:12' }, { text: 'Skip', callbackData: 's:12' }]]);
    expect(id).toBe(42);
    expect(f.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(f.calls[0].body).toEqual({ chat_id: '777', text: 'New job', reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'a:12' }, { text: 'Skip', callback_data: 's:12' }]] }, disable_web_page_preview: true });
  });

  it('never puts the bot token in error messages', async () => {
    const f = fakeFetch(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const err = (await createTelegramClient({ token: TOKEN, fetchImpl: f.impl }).sendMessage('1', 'x').catch((e: unknown) => e)) as TelegramError;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).toMatch(/Unauthorized/);
    expect(err.message).not.toContain('SECRET-TOKEN');
    const network = createTelegramClient({ token: TOKEN, fetchImpl: (async () => { throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/getMe`); }) as typeof fetch });
    const e2 = (await network.getUpdates(0, 0).catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain('SECRET-TOKEN');
  });

  it('reads updates from an offset', async () => {
    const f = fakeFetch(() => ({ ok: true, result: [{ update_id: 5, message: { chat: { id: 1 }, text: '/status' } }] }));
    const updates = await createTelegramClient({ token: TOKEN, fetchImpl: f.impl }).getUpdates(5, 0);
    expect(updates[0].update_id).toBe(5);
    expect(f.calls[0].body).toMatchObject({ offset: 5, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  });
});
