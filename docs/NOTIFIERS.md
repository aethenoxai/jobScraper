# Adding a notification channel

Notifications are created in one place (`notifier.notify(event, entityKey, message)`), stored in the `notifications` table, and delivered by the worker. The built-in channels:

- **In-app** (the inbox) and **browser** pop-ups: read from the database by the web UI.
- **Desktop**, **email** and **Telegram**: *external* channels, sent by the worker's `notify.send` and `notify.flush` tasks.

A new channel, such as Slack, ntfy, Pushover or Matrix, is an external channel.

## How delivery works

- `src/server/notifications/dispatcher.ts` decides, per event, which enabled channels get a row, de-duplicates by `(event, entityKey, channel)`, and schedules one send per channel (respecting quiet hours and a cool-down after a digest).
- `src/server/notifications/send.ts`:
  - `deliver()` sends one message on one channel;
  - `createNotifyFlushHandler` is the queue task that sends everything waiting on a channel, turning bursts into a single digest, with retries and backoff (`createNotifySendHandler` sends a single test message).
- A missing setup (no token, no address) throws `PermanentError` with a message telling the user what to add. It is shown in Settings → Notifications and on the System page, and it isn't retried.
- Secrets must be registered with `registerSecret()` so they never appear in logs or stored errors.

## Steps

1. **Channel name:** add it to `NOTIFICATION_CHANNELS` in `src/server/db/schema.ts` and to `EXTERNAL_CHANNELS` in `dispatcher.ts`.
2. **Settings:** add the switch to `NotificationSettingsSchema.channels` and `DEFAULT_NOTIFICATION_SETTINGS` in `src/server/notifications/settings.ts` (default `false`). Add the toggle to the form in `src/components/notifications/`.
3. **Configuration:** read tokens and addresses from the environment (document them in `.env.example` and [CONFIGURATION.md](CONFIGURATION.md)). Pass them into `SendDeps` from `src/worker/start.ts`.
4. **Sending:** add a branch to `deliver()`:

   ```ts
   } else if (n.channel === 'ntfy') {
     if (!deps.ntfy?.topicUrl) throw new PermanentError('ntfy is not set up: add NTFY_TOPIC_URL to your .env file.');
     const res = await fetch(deps.ntfy.topicUrl, { method: 'POST', headers: { Title: n.title, Click: url }, body: n.body, signal: AbortSignal.timeout(15_000) });
     if (!res.ok) throw new Error(`ntfy answered ${res.status}`); // retried by the queue
   }
   ```

   Send only what the message already contains: title, body and the link back to this app. Never CV text or contact details.
5. **Test message:** Settings → Notifications has "Send a test"; it goes through `sendTest(channel)` in the dispatcher, so it works once `deliver()` does.
6. **Tests:** follow `send.test.ts`:
   - a fake client records what was sent;
   - a missing setup becomes a `PermanentError` with a helpful message;
   - a server error is retried;
   - the token never appears in stored errors.
7. **Docs:** add the channel to [PRIVACY.md](PRIVACY.md) (what it receives and where it goes) and to CONFIGURATION.md.

Run `pnpm test src/server/notifications`, `pnpm typecheck` and `pnpm lint`.
