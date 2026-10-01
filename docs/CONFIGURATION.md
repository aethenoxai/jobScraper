# Configuration

Job Scraper has two places for settings:

- **In the app** (Settings in the sidebar): everything you change while using it, such as the AI provider and models, job sources, notifications, email sender, browser and tracking options, and how often to look for jobs. These are saved in the database.
- **`.env`** (in the project folder): secrets and things needed before the app starts, such as API keys, passwords and the data folder. `pnpm run setup` creates it from `.env.example`. Restart Job Scraper after changing it (AI keys are the exception: they are picked up while it runs).

Never commit `.env`. Values set in your shell take precedence over `.env`. Like Next.js, Job Scraper also reads `.env.local`, `.env.production` and `.env.production.local` (`.env.development…` under `pnpm dev`) if you create them; a value in a more specific file wins. The web page, the worker, `pnpm run setup`, the backup scripts and the evals all read them (the scripts use the production files unless `NODE_ENV` says otherwise).

Wrap a value that contains `#`, `$` or spaces in single quotes, for example `APP_PASSWORD='p#ss$word'`: unquoted, `#` starts a comment, and Docker Compose replaces `$name`.

## Basics

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Where the database, your files, backups and browser sign-ins are kept. Keep it out of cloud-synced folders. |
| `HOST` | `127.0.0.1` | Address the web UI listens on. Anything other than `127.0.0.1`/`localhost` requires `APP_PASSWORD`. |
| `PORT` | `3000` | Port of the web UI. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs never contain keys or passwords. |
| `LOG_FORMAT` | `pretty` | `pretty`: readable lines (terminal, `docker compose logs`); `json`: one JSON object per line, for a log collector. |

## AI provider

Setup asks for an AI model and tests it before you go on: it reads your CV and judges close matches. Later you can change it in **Settings → AI provider**, or choose "None" there to work with offline rules only. Only the key goes in `.env`: a key pasted during setup is written there for you (into the env file that already sets it, otherwise `.env`, readable only by you) and used without a restart. In Docker, put it in the `.env` next to `docker-compose.yml` and run `docker compose up -d`.

| Variable | For |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google (Gemini) |
| `OPENAI_COMPATIBLE_API_KEY` | Any OpenAI-compatible server (set its base URL in the app; the key is optional, many local servers take none) |
| `OLLAMA_BASE_URL` | Ollama, if not at `http://127.0.0.1:11434/api` (no key needed) |

Two choices need no key:

- **ChatGPT (sign in with your plan):** *Sign in with ChatGPT* in setup or on the AI page. OpenAI lets open-source apps that run on your own computer use your ChatGPT Plus or Pro plan this way. Open Job Scraper at `http://127.0.0.1:<PORT>` (not `localhost`) before signing in: OpenAI sends you back to `http://127.0.0.1:<PORT>/callback` and accepts no other address. The sign-in is kept in the database, like the Gmail and Outlook ones.
- **Claude (through your Claude Code):** Job Scraper runs the [Claude Code](https://claude.com/claude-code) installed on this computer (`claude -p`), signed in with your own account (`claude auth login`). It never sees your Claude password or tokens. Not available in Docker. If `ANTHROPIC_API_KEY` is set in the shell that starts Job Scraper, Claude Code bills that key instead of your plan. Anthropic sets the terms for using Claude Code from other tools and may change them.

The AI page also sets a **daily spending limit**; AI work pauses for the day when it is reached. Plans have no per-call price, so for them it sets a **number of AI calls per day** instead (300 by default), so matching can't use up your plan. Without a provider, matching and tailoring use offline rules.

## Job sources

Most sources need no setup and are turned on at first start (Remotive, Remote OK, Arbeitnow, Himalayas). You can add any company's job board on Greenhouse, Lever, Ashby, Workable, Recruitee or SmartRecruiters on the *Job sources* page, or paste a job link on *All jobs*.

| Variable | For |
| --- | --- |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | The Adzuna source (free key from developer.adzuna.com) |
| `BRAVE_SEARCH_API_KEY` | *Web discovery* with Brave Search (finds career pages and job boards by search) |

Web discovery can use your own SearXNG instead (set its address in the source's settings).

## Applying by email

See [setup/email.md](setup/email.md) for step-by-step instructions (app passwords, Gmail, Outlook).

| Variable | Meaning |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT` | Your provider's SMTP server, e.g. `smtp.gmail.com`, `587` |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | The account and its app password |
| `SMTP_FROM` | Sender address, if different from `SMTP_USERNAME` |
| `SMTP_SECURE` | `true` for TLS from the start (usually port 465); otherwise STARTTLS is required |
| `SMTP_ALLOW_SELF_SIGNED` | `true` only for a mail server on your own network with its own certificate |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Connect Gmail with OAuth instead of an app password |
| `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` | Connect Outlook / Microsoft 365 with OAuth (secret only for confidential clients) |

## Reading replies (inbox tracking)

Turned on in **Settings → Tracking**. Gmail/Outlook connected with OAuth, and common SMTP providers, need nothing more. Otherwise:

| Variable | Meaning |
| --- | --- |
| `IMAP_HOST`, `IMAP_PORT` | Your IMAP server (port 993 = TLS; other ports require STARTTLS) |
| `IMAP_SECURE` | Defaults to `true` on port 993 |
| `IMAP_USERNAME`, `IMAP_PASSWORD` | Only if different from the SMTP account; a different user always needs its own password |
| `IMAP_ALLOW_SELF_SIGNED` | `true` only for a server on your own network |

## Notifications

Choose channels and events in **Settings → Notifications**. In-app notifications need nothing. Desktop notifications use your operating system. Email notifications use the email setup above. Telegram needs:

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | A bot you create with @BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | Your chat id. The bot sends to and takes approve/skip actions from this chat only; anyone else who writes to it only gets their own chat id back (that's how you find yours) |

## Applying in the browser

Set in **Settings → Browser**: a visible or hidden browser window, a daily limit of website applications, and signing in to sites once.

| Variable | Meaning |
| --- | --- |
| `JOB_SCRAPER_BROWSER_HEADLESS` | `true` always uses a hidden browser (servers, Docker) |

## Access from other devices

By default, only this computer can open the web UI. Requests with any other host name are refused, which also protects against DNS-rebinding attacks from websites you visit.

| Variable | Meaning |
| --- | --- |
| `APP_PASSWORD` | Requires signing in (at least 8 characters). Required when `HOST` isn't `127.0.0.1`/`localhost`. |
| `APP_ALLOWED_HOSTS` | Extra host names you'll use in the address bar, comma-separated (e.g. `jobs.home.lan`) |

Use only on a network you trust. The connection is plain HTTP unless you put a TLS reverse proxy in front.

## Docker

| Variable | Meaning |
| --- | --- |
| `TZ` | Your time zone (e.g. `Europe/Berlin`), for quiet hours, daily limits and interview times; the container uses UTC otherwise |

Desktop notifications don't work inside Docker (there is no desktop); use in-app, browser, email or Telegram notifications.

## Advanced and internal

| Variable | Meaning |
| --- | --- |
| `JOB_SCRAPER_SKIP_BROWSER_INSTALL` | `true` makes `pnpm run setup` skip downloading Chromium |
| `JOB_SCRAPER_IN_DOCKER` | Set by the Docker image (allows `HOST=0.0.0.0` because the port is published on 127.0.0.1 only) |
| `JOB_SCRAPER_SEED_SOURCES` | `false` stops the worker from adding the default sources (used by the tests) |
| `JOB_SCRAPER_ALLOW_PRIVATE_URLS` | Tests only (fixture sites on localhost). Never set it: it lets job pages and the browser reach your own network. |

### Quality evals (contributors)

The AI versions of the evals (`pnpm eval:cv`, `eval:matching`, `eval:tailoring`, `eval:inbox`, without `--offline`) call a real model, with the provider's key from `.env`.

| Variable | Meaning |
| --- | --- |
| `EVAL_AI_PROVIDER` | `openai` (default), `anthropic`, `google`, `ollama` or `openai-compatible` |
| `EVAL_AI_MODEL` | The fast model to test (default: the provider's default) |
| `EVAL_AI_QUALITY_MODEL` | The quality model for tailoring (default: the provider's default) |
| `EVAL_AI_BASE_URL` | Server address for `ollama` or `openai-compatible` |
