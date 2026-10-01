import { z } from 'zod';
import { isNamedError } from '../../../lib/format';
import type { Logger } from '../../logging';
import type { MatchService } from '../../matching/service';
import type { ProfileService } from '../../profile/service';
import type { Scheduler } from '../../scheduler';
import type { SettingsStore } from '../../settings';
import type { Button, TelegramClient, TelegramUpdate } from './client';

/** Update offsets belong to one bot: switching bots must not skip the new bot's first messages. */
export const telegramOffsetKey = (botId: string) => `telegram.offset.${botId}`;
const POLL_SECONDS = 25;

/** Waits, but returns at once when the signal aborts (shutdown). */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

const HELP = [
  'Job Scraper bot',
  '/pending – jobs waiting for your decision',
  '/status – what Job Scraper is doing',
  '/pause – stop searching for jobs',
  '/resume – start searching again',
  'New matching jobs arrive here with ✅ Approve and ⏭ Skip buttons.',
].join('\n');

export function createTelegramBot(deps: {
  client: TelegramClient;
  allowedChatId: string | null;
  settings: SettingsStore;
  matching: MatchService;
  profiles: ProfileService;
  scheduler: Scheduler;
  appUrl: string;
  log: Logger;
}) {
  const { client, log } = deps;
  const allowed = (chatId: string | number | undefined) => deps.allowedChatId !== null && String(chatId) === String(deps.allowedChatId);

  async function onCommand(chatId: string | number, text: string) {
    const command = text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    if (command === '/start' && !allowed(chatId)) {
      // Only reveals the sender's own chat id, which they need for TELEGRAM_ALLOWED_CHAT_ID.
      await client.sendMessage(chatId, `Hi! Your chat id is ${chatId}.\nAdd TELEGRAM_ALLOWED_CHAT_ID=${chatId} to Job Scraper's .env file and restart it to receive job alerts here.`);
      return;
    }
    if (!allowed(chatId)) return;
    switch (command) {
      case '/pending': {
        const items = deps.profiles.list().flatMap((p) => deps.matching.feed(p.id, { state: 'pending', pageSize: 5 }).items.map((i) => ({ ...i, profile: p.name })));
        if (!items.length) {
          await client.sendMessage(chatId, 'Nothing is waiting for your decision.');
          return;
        }
        for (const i of items.slice(0, 5)) {
          const buttons: Button[][] = [[{ text: '✅ Approve', callbackData: `a:${i.matchId}` }, { text: '⏭ Skip', callbackData: `s:${i.matchId}` }]];
          await client.sendMessage(chatId, `${i.title}\n${i.company} · ${i.location ?? 'location not stated'}\nMatch ${i.score}% · ${i.profile}\n\n${deps.appUrl}/feed/${i.matchId}`, buttons);
        }
        return;
      }
      case '/status': {
        const c = deps.matching.counts();
        const s = deps.scheduler.getState();
        await client.sendMessage(
          chatId,
          [`Job search: ${s.enabled ? `running every ${s.intervalMinutes} min` : 'paused'}`, `Matching jobs: ${c.matching} (${c.awaitingApproval} awaiting your decision)`, `Applications: ${c.preparing} preparing · ${c.ready} ready · ${c.submitted} submitted · ${c.interviews} interviews`].join('\n'),
        );
        return;
      }
      case '/pause':
        deps.scheduler.stop();
        await client.sendMessage(chatId, '⏸ Job search paused. Send /resume to start again.');
        return;
      case '/resume':
        deps.scheduler.start();
        await client.sendMessage(chatId, '▶️ Job search resumed.');
        return;
      default:
        await client.sendMessage(chatId, HELP);
    }
  }

  async function onButton(q: NonNullable<TelegramUpdate['callback_query']>) {
    const chatId = q.message?.chat.id;
    if (!allowed(chatId)) {
      await client.answerCallbackQuery(q.id, 'This chat is not allowed to control Job Scraper.').catch(() => {});
      return;
    }
    const m = (q.data ?? '').match(/^([as]):(\d+)$/);
    if (!m) {
      await client.answerCallbackQuery(q.id);
      return;
    }
    const matchId = Number(m[2]);
    const match = deps.matching.get(matchId);
    let note: string;
    if (!match) note = 'That job is no longer in your feed.';
    else if (m[1] === 'a') {
      if (match.reviewState === 'APPROVED') note = '✅ Already approved.';
      else {
        try {
          deps.matching.approve(matchId, undefined, 'telegram');
          note = '✅ Approved – preparing your application.';
        } catch (err) {
          if (!isNamedError(err, 'JobClosedError')) log.warn({ error: (err as Error).message, matchId }, 'telegram approve failed');
          note = isNamedError(err, 'JobClosedError') ? '🚫 This job has closed, so nothing was prepared.' : 'Could not approve this job; open Job Scraper to try again.';
        }
      }
    } else if (match.reviewState === 'APPROVED') note = 'Already approved – your application is being prepared. Withdraw it in Job Scraper if you changed your mind.';
    else if (match.reviewState === 'SKIPPED') note = '⏭ Already skipped.';
    else note = deps.matching.skip(matchId) ? '⏭ Skipped.' : 'Nothing to skip.';

    // Answer and update independently: a press answered too late (e.g. after downtime) still updates the message.
    await client.answerCallbackQuery(q.id, note).catch((err) => log.debug({ error: (err as Error).message }, 'telegram answer failed'));
    if (q.message && chatId !== undefined) {
      await client.editMessageText(chatId, q.message.message_id, `${q.message.text ?? ''}\n\n${note}`).catch((err) => log.debug({ error: (err as Error).message }, 'telegram edit failed'));
    }
  }

  const bot = {
    async handleUpdate(u: TelegramUpdate): Promise<void> {
      if (u.callback_query) return onButton(u.callback_query);
      if (u.message?.text) return onCommand(u.message.chat.id, u.message.text);
    },

    /** One long-poll round: fetch updates after the stored offset, handle them, remember the new offset. */
    async pollOnce(signal: AbortSignal): Promise<number> {
      const key = telegramOffsetKey(client.botId);
      const offset = deps.settings.get(key, z.number().int(), 0);
      const updates = await client.getUpdates(offset, signal.aborted ? 0 : POLL_SECONDS, signal);
      for (const u of updates) {
        try {
          await bot.handleUpdate(u);
        } catch (err) {
          log.warn({ error: (err as Error).message }, 'telegram update failed');
        }
        deps.settings.set(key, u.update_id + 1);
      }
      return updates.length;
    },

    /** Polls until the signal aborts, backing off after errors. */
    async run(signal: AbortSignal): Promise<void> {
      let backoff = 5_000;
      while (!signal.aborted) {
        try {
          await bot.pollOnce(signal);
          backoff = 5_000;
        } catch (err) {
          if (signal.aborted) break;
          log.warn({ error: (err as Error).message }, 'telegram polling failed; retrying');
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 5 * 60_000);
        }
      }
    },
  };
  return bot;
}
