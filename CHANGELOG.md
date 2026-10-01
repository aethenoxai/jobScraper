# Changelog

## Unreleased

### Setup
- A setup wizard opens on first start, one step at a time: AI model, CV, profile check, the jobs you want, start. Every other page waits until it is finished, and nothing is searched or matched before you press *Start job search*.
- The AI step tests the model before you go on. A key pasted there is saved in `.env` and used without a restart.
- Two ways to use an AI plan instead of an API key: **Sign in with ChatGPT** (OpenAI's program for open-source local apps) and **Claude through your own Claude Code** (`claude -p`, signed in with your account). Plans have a daily number of AI calls instead of a dollar budget.
- The jobs step asks for country, state and city (Indian states are now recognised, and cities know their state), remote jobs, work mode, job type, expected salary (CTC) with a *negotiable* switch, notice period and match level.

### Updating
- The *System* page shows the installed version, with links to the latest release and the update steps (the app itself never contacts GitHub). The README explains how to update a clone.

### Changed
- The *Get started* checklist is replaced by the wizard; `/setup` leads there.
- "Minimum salary" is now "Expected salary": jobs stating less are held back unless it is negotiable, in which case they are shown with a note.

## 1.0.0

The first public release. Job Scraper runs on your own computer and covers the whole search, from finding jobs to tracking replies.

### Finding jobs
- Job sources on first start: Remotive, Remote OK, Arbeitnow, Himalayas.
- Any company's board on Greenhouse, Lever, Ashby, Workable, Recruitee or SmartRecruiters.
- Adzuna, with a key.
- Web discovery through Brave Search or SearXNG.
- Add a job by link (structured job data, or the board behind an ATS link) or by pasting it.
- Duplicates across sources become one job. Changed and closed postings are noticed; politeness limits are respected per source.

### Matching
- A score from 0 to 100, with the reasons, per profile: must-have requirements, skills, experience, seniority, location (countries and states), work mode, salary, and the language a posting is written in.
- A slider from "close matches only" to "worth a look".
- Several profiles for different kinds of roles.
- Works offline. An AI provider (OpenAI, Anthropic, Google, OpenAI-compatible or Ollama) improves it, within a daily budget.

### Applying
- For each job you approve:
  - a tailored CV (two templates) and cover letter, checked against your profile so no fact is invented;
  - a change report;
  - PDFs to download;
  - editors for both.
- Apply by email from your own account (SMTP, or Gmail/Outlook with OAuth), with proof from the mail server. Nothing is ever sent twice.
- Apply in the browser:
  - Job Scraper fills in truthful answers and uploads the CV;
  - it skips CAPTCHAs, verification codes, sign-in walls and questions your profile can't answer, with the reason;
  - it records "applied" only with a confirmation from the site;
  - daily limit, and an optional visible browser.
- Never applies without your approval.

### After applying
- Statuses, notes, interviews and offers. Upcoming interviews appear on the dashboard.
- Optional inbox tracking (IMAP). Only mail about your applications is opened. Replies are linked and interpreted, and status changes are suggested. Automatic updates are limited to interview invitations read by an AI model.
- Notifications in the app, in the browser, on the desktop, by email and on Telegram (with approve/skip buttons), with quiet hours and digests.

### Running it
- A *Get started* page for the first run, and a *System* page showing what ran and what failed.
- Works on phone-width screens; keyboard and screen-reader friendly (page titles, skip link, current page marked).
- Native install or Docker.
- Automatic backups before database changes, plus `pnpm backup` and `pnpm restore` (which refuses while Job Scraper is running). Backup folders are named in your local time.
- Survives crashes without losing or repeating work.
- Daily clean-up of old data, including the text of jobs gone for months; the database is compacted weekly.
- Readable logs (`LOG_FORMAT=json` for log collectors). The web page, the worker and the scripts read the same `.env` files.
- Privacy and security:
  - only this computer can reach the web UI unless you set a password;
  - private file permissions;
  - secrets never logged.
