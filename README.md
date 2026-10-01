# Job Scraper

Your own job-search assistant that runs on your computer. It looks for jobs that fit your CV and preferences, tells you about the good ones, writes a CV and cover letter tailored to each job you approve, helps you apply, and keeps track of what happens next.

- **Local first.** Your CV, applications and history stay on your computer. Nothing is sent anywhere unless you turn on an integration (an AI provider, email, Telegram); [PRIVACY.md](docs/PRIVACY.md) lists exactly what each one receives.
- **You stay in charge.** Job Scraper never applies on its own. Every application waits for your approval, and you can edit the CV and letter first.
- **Truthful CVs.** Tailored CVs and letters may reword and reorder your experience, but every fact must come from your profile. Anything that can't be checked against it is kept in your original words.
- **Works without AI.** Matching and tailoring have offline rules. An AI provider (OpenAI, Anthropic, Google, or a local Ollama) makes them better. You can set a daily spending limit.

## Quick start

You need Node.js 24 and pnpm 10 (`corepack enable` sets up pnpm), plus [uv](https://docs.astral.sh/uv/) or Python 3.10+ for [Scrapling](https://github.com/D4Vinci/Scrapling), which reads job pages. Then:

```bash
git clone https://github.com/aethenoxai/jobScraper.git job-scraper && cd job-scraper
pnpm install
pnpm run setup      # creates .env and the database, downloads Chromium (for PDFs) and sets up Scrapling
pnpm build
pnpm start          # the web UI and the background worker
```

Open **http://127.0.0.1:3000**. A short setup opens first, one step at a time. Nothing is searched until you finish it:

1. Choose the AI model: sign in with your ChatGPT plan, use the Claude Code on your computer, paste an API key (it is saved in your `.env`) or use a local Ollama server. It is tested before you go on.
2. Drop in your CV (PDF, Word .docx or .doc). That model reads it; remove or replace the file any time.
3. Check and correct your profile.
4. Say which jobs you want: titles, country, state and city, remote or not, job type, expected salary (negotiable or not) and notice period.
5. Start the job search. The dashboard opens.

Job sources and notifications start with sensible defaults; change them any time in Settings.

### With Docker

```bash
cp .env.example .env && chmod 600 .env
docker compose up -d
```

Then open http://127.0.0.1:3000. Your data is kept in the `job-scraper-data` volume. In Docker, applying on websites uses a hidden browser; use the native install if you want to watch it apply.

More detail: [docs/INSTALL.md](docs/INSTALL.md) covers macOS, Linux, Windows (WSL), Docker, updating and backups.

## Updating

Stop Job Scraper (Ctrl+C), then in its folder:

```bash
git pull
pnpm install
pnpm exec playwright install chromium   # quick when nothing changed
pnpm run setup                          # updates Scrapling when its version changed (quick otherwise)
pnpm build
pnpm start
```

With Docker: `git pull && docker compose up -d --build`.

Your `.env` and `data/` are not touched, and database changes apply on start after an automatic backup. To hear about new versions, choose **Watch → Custom → Releases** on GitHub. The **System** page shows the version you run and links to the latest release. See [CHANGELOG.md](CHANGELOG.md) for what changed and [docs/INSTALL.md](docs/INSTALL.md#updating) for details.

## Daily use

- **Job feed:** new matches with a score and the reasons for it. Approve the ones you want; skip the rest.
- **Applications:** each approved job gets a tailored CV (PDF) and cover letter. Review and edit them, then apply:
  - by email, from your own account;
  - in the browser, where Job Scraper fills in the form from your profile and uploads the CV;
  - yourself, then mark it as applied.

  Anything Job Scraper can't do truthfully (a CAPTCHA, a verification code, a question your profile doesn't answer) is skipped, with the reason shown.
- **Tracking:** statuses from applied to offer, notes and interviews. Optionally, replies from employers are read from your inbox and suggested as status changes.
- **System:** what ran, what failed and why, and AI spending.

## Configuration

Most settings live in the app (Settings in the sidebar). API keys and passwords go in `.env`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every option and [docs/setup/email.md](docs/setup/email.md) for email.

## Your data

Everything is in `data/` (or the Docker volume): the database, your CVs, generated documents, backups and browser sign-ins. Keep it, and `.env`, out of cloud-synced folders and never commit them. Back up with `pnpm backup`; restore with [docs/RESTORE.md](docs/RESTORE.md).

## Responsible use

Job Scraper reads public job boards through their APIs or published job data, at a polite pace. It never automates LinkedIn, Indeed or similar sites, and never solves CAPTCHAs. It applies only where you approved it, within a daily limit you set. You are responsible for the accounts and providers you connect, and for respecting each site's terms.

## Contributing

New job sources, notification channels, AI and email providers and fixes are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then [docs/ADAPTERS.md](docs/ADAPTERS.md) or [docs/NOTIFIERS.md](docs/NOTIFIERS.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
