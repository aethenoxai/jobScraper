# Installing Job Scraper

Two ways to run it:

- **Native**: Node.js on your computer. Best for everyday use; you can watch browser applications happen.
- **Docker**: one container. Nothing to install except Docker. Browser applications run with a hidden browser.

Both keep everything on your computer and open the web interface at **http://127.0.0.1:3000**.

## Native install

### What you need

- **Node.js 24** (the version in `.nvmrc`; 22 is the minimum).
- **pnpm 10**: run `corepack enable` once (it comes with Node).
- About 1 GB of disk for dependencies and the Chromium browser, plus room for your data.

### macOS

```bash
brew install node@24 && brew link --overwrite --force node@24   # or use nvm / fnm
corepack enable
git clone https://github.com/aethenoxai/jobScraper.git job-scraper && cd job-scraper
pnpm install
pnpm run setup
pnpm build
pnpm start
```

### Linux (Ubuntu/Debian)

Install Node 24 from [nodejs.org](https://nodejs.org/) or with nvm, then do the same steps as on macOS. Chromium needs some system libraries; if PDFs fail to render, install them once:

```bash
pnpm exec playwright install --with-deps chromium   # asks for your password to install the libraries
```

### Windows

Use **WSL 2** with Ubuntu (`wsl --install` in an administrator PowerShell, then restart), and follow the Linux steps inside WSL. Open http://127.0.0.1:3000 in your Windows browser. Running directly on Windows (outside WSL) is not tested.

### What `pnpm run setup` does

- creates `.env` from `.env.example` (an existing `.env` is never overwritten);
- creates the data folder (`data/`, or `DATA_DIR`) and the database;
- downloads Chromium for PDF rendering and browser applications. Set `JOB_SCRAPER_SKIP_BROWSER_INSTALL=true` to skip it, then run `pnpm exec playwright install chromium` yourself later.

### Running

| Command | What it does |
| --- | --- |
| `pnpm start` | Web UI and background worker (after `pnpm build`). Stop with Ctrl+C. |
| `pnpm dev` | The same with live reload, for working on Job Scraper itself. |
| `pnpm start:web` / `pnpm start:worker` | One of the two only. Both must run for scanning, preparing and sending to happen. |

The worker does the slow work: scanning job sources, AI calls, rendering PDFs, sending email, applying in the browser and reading your inbox. The web UI shows a warning when the worker isn't running.

To keep it running in the background, use your system's tools (a `launchd` agent on macOS, a `systemd --user` service on Linux), or Docker.

## Docker

```bash
git clone https://github.com/aethenoxai/jobScraper.git job-scraper && cd job-scraper
cp .env.example .env && chmod 600 .env   # keys and passwords go here: readable only by you
docker compose up -d        # the first start builds the image (several minutes)
```

Open http://127.0.0.1:3000.

- The port is published on `127.0.0.1` only, so other computers can't reach it.
- Your data lives in the `job-scraper-data` volume. It survives `docker compose down` and rebuilds; `docker compose down -v` deletes it.
- Browser applications run with a hidden browser; signing in to a site (Settings → Browser) needs the native install.
- Logs: `docker compose logs -f`. Status: `docker compose ps` (the health check calls `/api/health`).
- Back up and restore: see [RESTORE.md](RESTORE.md#with-docker). Copy backups to a folder outside the project (they contain your data and email sign-in tokens).
- Set `TZ` in `.env` (e.g. `TZ=Europe/Berlin`) so quiet hours and daily limits follow your clock.
- Desktop notifications don't work in Docker; use in-app, browser, email or Telegram ones.

To reach it from other devices on your network, set `APP_PASSWORD` in `.env`, publish the port more widely in `docker-compose.yml`, and add the host name you use to `APP_ALLOWED_HOSTS`. See [CONFIGURATION.md](CONFIGURATION.md#access-from-other-devices).

## Updating

Stop Job Scraper first (Ctrl+C), then:

```bash
git pull
pnpm install
pnpm exec playwright install chromium   # when the Playwright version changed (quick otherwise)
pnpm build
pnpm start
```

Don't skip `pnpm build`: `pnpm start` serves the last build, so the web interface would stay on the old version while the worker runs the new one. Database changes apply automatically on start, after a snapshot of the database is saved in `data/backups/pre-migration-<time>/`. With Docker: `git pull && docker compose up -d --build`.

To hear about new versions, choose **Watch → Custom → Releases** on the GitHub repository. The System page shows the version you run, with links to the latest release and to these steps; [CHANGELOG.md](../CHANGELOG.md) lists what changed.

## Backups and restore

- `pnpm backup` writes a consistent copy of the database and your files to `data/backups/backup-<time>/` and keeps the latest ten. It never includes `.env`.
- To restore, stop Job Scraper and follow [RESTORE.md](RESTORE.md).

## Uninstalling

Stop Job Scraper and delete the project folder, including `data/` and `.env`. With Docker, run `docker compose down -v` and remove the `job-scraper:local` image. If you connected Gmail or Outlook, also remove Job Scraper from your account's connected apps.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Another Job Scraper worker is already running" | A worker is still running (in another terminal, or Docker). Stop that one first; after a crash, starting again just works. |
| "This address is not allowed" | Open http://127.0.0.1:3000 (or `localhost`). Other host names need `APP_ALLOWED_HOSTS`. |
| PDFs aren't created | Run `pnpm exec playwright install chromium` (Linux: `pnpm exec playwright install --with-deps chromium`). |
| No jobs appear | Finish setup first (it opens at http://127.0.0.1:3000/welcome): nothing is searched before you press *Start job search*. Then check that at least one source is on and discovery runs (Settings → Scheduling). The *System* page shows each source's last run and error. |
| An AI key doesn't work | The setup step and Settings → AI provider show the provider's error. Keys live in `.env`; a key pasted in setup is saved there and used without a restart. A key set in your shell wins over `.env`. In Docker, edit `.env` and run `docker compose up -d`. |
