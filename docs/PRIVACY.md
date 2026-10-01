# Privacy: what leaves your computer

Job Scraper runs on your own computer. It has no account, server, analytics or telemetry of its own, and it switches off the usage telemetry of Next.js (the web framework it is built on) for `pnpm build`, `pnpm dev`, `pnpm start` and Docker. Data only leaves your machine through the integrations you turn on, and each one is listed below with exactly what it receives.

## Stays on your computer

Everything Job Scraper keeps is stored in the data folder (`DATA_DIR`, by default `./data`):

| What | Where |
| --- | --- |
| Your profiles, preferences, jobs, matches, applications and their history | `data/job-scraper.db` (SQLite) |
| Uploaded CVs, tailored CVs and cover letters (PDF/HTML/JSON), screenshots | `data/files/` |
| Website sign-ins for applying in the browser (cookies) | `data/browser-profiles/<site>/` |
| Email OAuth refresh tokens (Gmail/Outlook) | the database's settings table |
| Backups (database + files; never `.env`) | `data/backups/` |
| API keys, SMTP/IMAP passwords, bot tokens | `.env` |

None of this is encrypted by Job Scraper. Protect it like your password manager's export:

- Keep the project folder **out of cloud-synced folders** (iCloud Desktop & Documents, OneDrive, Dropbox). Otherwise your CV, tokens and website sessions are uploaded with everything else. On macOS, `~/Desktop` and `~/Documents` are synced when "Desktop & Documents Folders" is on in iCloud settings. Set `DATA_DIR` to a folder outside them, e.g. `~/.local/share/job-scraper`.
- On a computer shared with other people, keep the folder in your own home directory.
- `.env` and `data/` are excluded from Git; never commit them.

Logs never contain API keys, passwords or tokens: known secrets are removed from every log line and every error shown in the app.

## What each integration receives

### AI provider (optional: OpenAI, Anthropic, Google, OpenAI-compatible, or Ollama)

With **no AI provider**, nothing is sent: Job Scraper uses offline rules. With **Ollama** (or any OpenAI-compatible server on your own machine or network), the data below goes to that server and no further. With a cloud provider, the provider receives:

| When | What is sent |
| --- | --- |
| Reading your uploaded CV | The CV's text (up to 30,000 characters) |
| Scoring a job against a profile | The job's requirements and title; your target roles, years of experience, profile items (experience, skills, projects, education, certifications, languages; up to 300 characters each) and work-authorisation text |
| Analysing a job description | The job description |
| Tailoring a CV / writing a cover letter | Your profile (experience, skills, education, summary, headline) and the job's title, company and description |
| Answering an application form in the browser | The questions Job Scraper's rules couldn't answer (labels and offered options), the job's title and company, and your headline, summary, location, years of experience, skills, experience, projects, education, certifications and languages. Never your email, phone, salary or visa details. Demographic, legal and file questions are never sent. |
| Reading a reply from an employer | The email's sender, subject and text, **only** for emails already linked to one of your applications |
| Reading a job page found by web search | The page's address and text (no personal data) |

Each provider handles this under its own API terms; check whether yours keeps or trains on API data. A daily spending limit can be set in Settings → AI provider.

### Job sources and web search

Job boards and applicant-tracking systems (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Remotive, RemoteOK, Arbeitnow, Himalayas, Adzuna) and the optional web search (Brave Search or your SearXNG) receive ordinary web requests. Searches contain only your target job titles, locations and keywords from your preferences. No name, contact details or CV are sent. Adzuna and Brave also receive your API key for that service. Job Scraper never contacts LinkedIn, Indeed, Glassdoor, Naukri and similar sites.

### Applying by email (SMTP, Gmail or Outlook)

Your mail provider sends the application you approved: the recipient from the job posting, the subject, the cover letter text, your name and contact details, the tailored CV PDF and optionally the cover letter PDF. The employer receives that email. Nothing is sent without your click on "Send".

### Applying in the browser

The job's website receives what a person filling in its form would send: the answers taken from your profile, the tailored CV (and cover letter, if the form asks for one) and the site's own cookies. Job Scraper only fills answers your profile supports. It never sends demographic answers other than "decline to self-identify", never solves CAPTCHAs and never enters verification codes. Website sign-ins stay in `data/browser-profiles/`. The first install downloads Chromium from Playwright's servers.

### Inbox tracking (IMAP)

Job Scraper signs in to your mailbox read-only (it never marks mail as read, moves or deletes it). For each new message it reads the sender, subject and thread headers. It opens a message only when those point to one of your applications. Only opened messages that are about an application are stored, as the sender, subject and the first 4,000 characters. With an AI provider set, those messages are also sent to it for interpretation (see above). The mailbox password or OAuth token is used only to sign in to your mail server.

### Notifications

| Channel | What is sent, and to whom |
| --- | --- |
| In-app and browser notifications | Nothing leaves the computer |
| Desktop notifications | Your operating system's notification centre (local) |
| Email notifications | The notification text, sent through your mail provider to the address you set: job title, company, location and work mode, score or status; for replies from employers, the email's subject and sender address; for applications, the address it was sent to; for problems, the error message (e.g. why an application failed or a source stopped working); a link back to this app |
| Telegram | The same text, sent to Telegram's servers and delivered to your chat; buttons for approve/skip come back through Telegram |

### Access from other devices

By default the web interface answers only on this computer. If you set `HOST` to make it reachable on your network, `APP_PASSWORD` is required; the password and its session cookie never leave your network.

## Deleting your data

- **An application:** "Delete" on its page removes its tailored CV, cover letter, emails, screenshots and history. Your profile and master CV stay.
- **A profile:** Profiles → delete removes the profile, its uploaded CV, its matches and its applications with all their files.
- **Website sign-ins:** delete the site's folder in `data/browser-profiles/`.
- **Email connection:** Settings → Email → Disconnect removes the stored token; also revoke Job Scraper in your Google or Microsoft account's connected apps.
- **Everything:** stop Job Scraper and delete the `data/` folder (and `.env`).

Copies of deleted applications and profiles stay in the backups in `data/backups/` (the newest 10 backups, 5 pre-upgrade snapshots and 10 folders set aside by restores) until newer ones replace them. Delete those folders too if the data must be gone at once.

Data an integration has already received (an email sent, an answer submitted, a prompt sent to an AI provider) is governed by that service and can't be recalled by Job Scraper.
