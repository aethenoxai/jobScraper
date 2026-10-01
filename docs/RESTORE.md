# Backups and restore

Everything Job Scraper knows lives in the `data/` folder:
- `job-scraper.db` holds profiles, jobs, matches, applications and settings;
- `files/` holds your CVs, tailored CVs, cover letters and screenshots;
- `browser-profiles/` holds website sign-ins.

Your keys and passwords live in `.env`.

## Making a backup

```
pnpm backup
```

This saves a consistent copy of the database (safe while Job Scraper is running) and the `files/` folder to `data/backups/backup-<time>/`. The newest 10 backups are kept.

Job Scraper also takes a snapshot automatically **before every database upgrade** (`data/backups/pre-migration-<time>/`, the newest 5 are kept). These snapshots hold the database only; restoring one keeps your current files. Folder names use your computer's local time.

Backups never include `.env` or website sign-ins. Keep a copy of your `.env` somewhere safe yourself, such as a password manager.

To keep a copy off this computer, copy the backup folder to an external drive or storage you trust. It contains personal data (your CV and applications) and, if you connected Gmail or Outlook, the sign-in token that lets Job Scraper send mail as you. Treat it like a password: don't put it in shared or public cloud folders, and keep it outside the project folder.

## Restoring

1. Stop Job Scraper (Ctrl+C in its terminal, or `docker compose down`).
2. List the backups: `pnpm restore`
3. Restore one: `pnpm restore data/backups/backup-2026-10-01_10-00-00`

`pnpm restore` refuses while Job Scraper's web page or worker is still running. If another program uses the same port, add `--force`.

The data that was replaced is moved to `data/backups/replaced-<time>/` (the newest 10 are kept), so a restore can be undone the same way. Start Job Scraper again. If the backup is from an older version, the database is upgraded on start (after another automatic snapshot).

## With Docker

Your data is in the `job-scraper-data` volume, not in `./data`, so run the commands inside the container:

```
docker compose exec job-scraper pnpm backup                 # make a backup (while running)
docker compose stop                                         # stop before restoring
docker compose run --rm job-scraper pnpm restore            # list the backups
docker compose run --rm job-scraper pnpm restore /app/data/backups/backup-2026-10-01_10-00-00
docker compose start
```

To copy backups off the volume: `docker compose cp job-scraper:/app/data/backups ~/job-scraper-backups` (a folder outside the project).
