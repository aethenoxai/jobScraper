# Contributing to Job Scraper

Thanks for helping. Job Scraper is a local-first job-search assistant; contributions that make it find better jobs, apply more reliably and stay honest are very welcome.

## Ground rules

These are non-negotiable:

- **Nothing is applied without the user's approval.** Never add automatic applying.
- **CVs and letters stay truthful.** Generated text may reword and reorder; every fact must trace to the user's profile. Changes to tailoring must keep the grounding validator and the tailoring eval at 100%.
- **No evasion.** No CAPTCHA solving, no bypassing logins or rate limits, no automating LinkedIn/Indeed or sites whose terms forbid it.
- **Local first and private.** No telemetry. Secrets are never logged. Personal data leaves the machine only through integrations the user turned on, as listed in [docs/PRIVACY.md](docs/PRIVACY.md).
- **Never commit** `.env`, anything in `data/`, or real CVs and personal data. Test fixtures use invented people.

## Getting started

```bash
pnpm install
pnpm run setup
pnpm dev            # web UI and worker with live reload
```

| Command | Purpose |
| --- | --- |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright, against a production build) |
| `pnpm typecheck`, `pnpm lint` | Must be clean |
| `pnpm eval:matching --offline`, `pnpm eval:tailoring --offline`, `pnpm eval:inbox --offline` | Quality gates; run without `--offline` with a provider key for the AI versions |
| `pnpm db:generate` | After changing `src/server/db/schema.ts`; commit the new file in `drizzle/` |

## How the code is organised

- `src/app/`: the web UI (Next.js App Router). Pages read data on the server; changes go through server actions.
- `src/worker/`: the background process: queue runner, scheduler, task handlers.
- `src/server/`: everything else, by area: `sources` (adapters), `discovery`, `jobs` (ingest, dedupe), `matching`, `tailoring`, `applications`, `email`, `browser`, `tracking`, `notifications`, `ai`, `db`, `queue`.
- The web UI and the worker talk only through the database. Slow work (AI, scraping, rendering, email, the browser) always runs in the worker.

## Common contributions

- **A job source:** [docs/ADAPTERS.md](docs/ADAPTERS.md)
- **A notification channel:** [docs/NOTIFIERS.md](docs/NOTIFIERS.md)
- **An AI provider:**
  1. Add it to `AI_PROVIDERS`, `DEFAULT_MODELS`, `PROVIDER_LABELS` and (if it needs a key) `KEY_ENV_VAR` in `src/server/ai/settings.ts`, and to `defaultModelFactory` in `src/server/ai/index.ts`, using its AI SDK provider package.
  2. Add a price estimate in `PRICES` for the daily budget.
  3. Add a test in `ai.test.ts`.
- **An email provider (OAuth):** add an entry to `PROVIDERS` in `src/server/email/oauth.ts` (endpoints, scopes, SMTP host) and its IMAP host to `OAUTH_IMAP` in `src/server/tracking/mailbox.ts`, then follow `oauth.test.ts`.
- **A CV template:** add it to `TEMPLATES` and `STYLES` in `src/server/tailoring/render.ts`. It must render every section and work with long names and many jobs.

## Pull requests

- Write the test first. A bug fix comes with a test that failed before the fix.
- Keep changes focused. Follow the style of the code around you; comments explain *why*.
- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Fill in the pull request template, including test evidence.
- UI text is plain and specific: say what happened and what to do next.

## Reporting bugs and ideas

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
