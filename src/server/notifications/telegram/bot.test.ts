import { eq } from 'drizzle-orm';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDb } from '../../../../tests/helpers/temp-db';
import { applications, jobListings, jobs, sources } from '../../db/schema';
import { createIngestor } from '../../jobs/ingest';
import { createLogger } from '../../logging';
import { createMatchService } from '../../matching/service';
import { DEFAULT_PREFERENCES, emptyProfile } from '../../profile/model';
import { createProfileService } from '../../profile/service';
import { createQueue } from '../../queue';
import { createScheduler } from '../../scheduler';
import { createSettings } from '../../settings';
import { createFileStore } from '../../storage';
import { createTelegramBot, telegramOffsetKey } from './bot';
import type { TelegramClient, TelegramUpdate } from './client';

const log = createLogger({ level: 'silent' });
let t: ReturnType<typeof createTempDb>;
beforeEach(() => (t = createTempDb()));
afterEach(() => t.cleanup());

let answerFails = false;
beforeEach(() => (answerFails = false));

async function setup() {
  const settings = createSettings(t.db);
  const queue = createQueue(t.db);
  const profiles = createProfileService({ db: t.db, files: createFileStore(path.join(t.dir, 'f')) });
  const matching = createMatchService({ db: t.db, ai: null, queue, profiles, log });
  const scheduler = createScheduler({ settings, queue });
  const p = profiles.create('Engineer');
  const d = emptyProfile();
  d.headline = 'Backend Engineer';
  d.skills = [{ id: '', name: 'Go', category: 'skill' }];
  profiles.updateData(p.id, d);
  profiles.updatePreferences(p.id, { ...DEFAULT_PREFERENCES, targetTitles: ['Backend Engineer'] }, 70);
  const src = t.db.insert(sources).values({ adapterId: 'greenhouse', name: 'Acme', config: {}, origin: 'user', createdAt: new Date() }).returning().get().id;
  const [jobId] = createIngestor({ db: t.db }).ingestRun(src, [{ sourceJobId: '1', sourceUrl: 'https://x.example/1', title: 'Backend Engineer', company: 'Acme', description: 'Requirements\n• Go' }], { completeSnapshot: true }).changedJobIds;
  const { matchId } = await matching.evaluate(jobId, p.id);

  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    sendMessage: async (...args: unknown[]) => (calls.push({ method: 'sendMessage', args }), 1),
    editMessageText: async (...args: unknown[]) => void calls.push({ method: 'editMessageText', args }),
    answerCallbackQuery: async (...args: unknown[]) => {
      calls.push({ method: 'answerCallbackQuery', args });
      if (answerFails) throw new Error('query is too old');
    },
    getUpdates: async () => [],
    botId: '123',
  } as unknown as TelegramClient;
  const bot = createTelegramBot({ client, allowedChatId: '777', settings, matching, profiles, scheduler, appUrl: 'http://127.0.0.1:3000', log });
  return { bot, calls, matchId, scheduler, settings, matching, jobId };
}

const press = (data: string, chat: string | number = 777): TelegramUpdate => ({ update_id: 1, callback_query: { id: 'cb1', data, from: { id: 1 }, message: { message_id: 9, chat: { id: chat }, text: '🔔 New job' } } });
const say = (text: string, chat: string | number = 777): TelegramUpdate => ({ update_id: 2, message: { message_id: 3, chat: { id: chat }, text } });

describe('telegram bot', () => {
  it('approves from a button press through the same path as the UI, idempotently', async () => {
    const { bot, calls, matchId } = await setup();
    await bot.handleUpdate(press(`a:${matchId}`));
    await bot.handleUpdate(press(`a:${matchId}`));
    expect(t.db.select().from(applications).all()).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(2);
    expect(String(calls.find((c) => c.method === 'editMessageText')?.args[2])).toMatch(/Approved/);
  });

  it('ignores button presses and commands from other chats', async () => {
    const { bot, calls, matchId } = await setup();
    await bot.handleUpdate(press(`a:${matchId}`, 999));
    await bot.handleUpdate(say('/pause', 999));
    expect(t.db.select().from(applications).all()).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it('tells anyone their chat id on /start, so they can finish setup', async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(say('/start', 424242));
    expect(String(calls[0].args[1])).toContain('424242');
  });

  it('skips a job', async () => {
    const { bot, calls, matchId } = await setup();
    await bot.handleUpdate(press(`s:${matchId}`));
    expect(String(calls.find((c) => c.method === 'editMessageText')?.args[2])).toMatch(/Skipped/);
  });

  it('lists pending jobs with buttons, reports status, and pauses/resumes discovery', async () => {
    const { bot, calls, scheduler } = await setup();
    await bot.handleUpdate(say('/pending'));
    expect(calls.some((c) => c.method === 'sendMessage' && JSON.stringify(c.args[2] ?? '').includes('a:'))).toBe(true);
    await bot.handleUpdate(say('/status'));
    expect(String(calls.at(-1)?.args[1])).toMatch(/awaiting/i);
    await bot.handleUpdate(say('/resume'));
    expect(scheduler.getState().enabled).toBe(true);
    await bot.handleUpdate(say('/pause'));
    expect(scheduler.getState().enabled).toBe(false);
  });

  it('processes updates and remembers the offset', async () => {
    const { settings } = await setup();
    const updates: TelegramUpdate[][] = [[say('/help')], []];
    const client = { sendMessage: async () => 1, getUpdates: async () => updates.shift() ?? [], editMessageText: async () => {}, answerCallbackQuery: async () => {}, botId: '555' } as unknown as TelegramClient;
    const { profiles, matching, scheduler } = { profiles: createProfileService({ db: t.db, files: createFileStore(t.dir) }), matching: null as never, scheduler: null as never };
    const bot = createTelegramBot({ client, allowedChatId: '777', settings, matching, profiles, scheduler, appUrl: 'http://x', log });
    await bot.pollOnce(new AbortController().signal);
    // Remembered per bot, so switching to another bot doesn't skip its first messages.
    expect(settings.get(telegramOffsetKey('555'), (await import('zod')).z.number(), 0)).toBe(3);
  });

  const answerOf = (calls: Array<{ method: string; args: unknown[] }>) => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.args[1]);
  const editOf = (calls: Array<{ method: string; args: unknown[] }>) => calls.filter((c) => c.method === 'editMessageText').map((c) => String(c.args[2]));

  it('says a job is already approved instead of pretending to skip it', async () => {
    const { bot, calls, matchId } = await setup();
    await bot.handleUpdate(press(`a:${matchId}`));
    await bot.handleUpdate(press(`s:${matchId}`));
    expect(answerOf(calls)).toMatch(/already approved/i);
    expect(editOf(calls).some((t) => /Skipped/.test(t))).toBe(false);
  });

  it('does not approve a job that has closed since the message was sent', async () => {
    const { bot, calls, matchId, jobId } = await setup();
    t.db.update(jobs).set({ status: 'expired' }).where(eq(jobs.id, jobId)).run();
    t.db.update(jobListings).set({ status: 'expired' }).run();
    await bot.handleUpdate(press(`a:${matchId}`));
    expect(t.db.select().from(applications).all()).toHaveLength(0);
    expect(answerOf(calls)).toMatch(/closed/i);
  });

  it('answers a press for a job it does not know', async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(press('s:999999'));
    expect(answerOf(calls)).toMatch(/no longer/i);
  });

  it('still updates the message when the press can no longer be answered', async () => {
    const { bot, calls, matchId } = await setup();
    answerFails = true;
    await bot.handleUpdate(press(`a:${matchId}`));
    expect(t.db.select().from(applications).all()).toHaveLength(1);
    expect(editOf(calls).at(-1)).toMatch(/Approved/);
  });

  it('stops promptly when shut down while waiting to retry', async () => {
    const { settings } = await setup();
    const client = { getUpdates: async () => Promise.reject(new Error('offline')), botId: '1' } as unknown as TelegramClient;
    const bot = createTelegramBot({ client, allowedChatId: '777', settings, matching: null as never, profiles: null as never, scheduler: null as never, appUrl: 'http://x', log });
    const ac = new AbortController();
    const running = bot.run(ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    ac.abort();
    await running;
    expect(Date.now() - started).toBeLessThan(500);
  });
});
