# Releasing

## Publishing the repository for the first time

This repository has been developed privately. Its history and some files are working notes that aren't meant for the public. Publish from a **fresh repository**:

1. Check out the release commit in a clean folder.
2. Remove the internal working files:
   - `MEMORY.md`, `CLAUDE.md`, `AGENTS.md` and `HANDOVER.md` (notes for the maintainer and their coding assistant; `MEMORY.md` names the maintainer). `next dev` writes `AGENTS.md` and `CLAUDE.md` again when it detects a coding assistant, so add both to `.gitignore` in the public repository;
   - `.superpowers/` (ignored by Git, but double-check);
   - `docs/superpowers/` (implementation plans);
   - `docs/PLAN.md` (keep it only if you want to publish the build plan; nothing public links to it).
   - Keep `docs/PRD.md`: it is the product specification, and source comments cite its sections ("PRD §26").
3. Make sure no real personal data is left:
   - `pnpm test tests/repo-hygiene.test.ts` checks email addresses and doc links;
   - run [gitleaks](https://github.com/gitleaks/gitleaks) over the folder (`gitleaks dir .`);
   - look through `tests/fixtures/` (CVs there are invented; job-board fixtures are recorded public postings).
4. `git init`, commit everything as "Job Scraper 1.0.0", and push to the new public repository.
5. On GitHub, turn on private vulnerability reporting (Settings → Code security), as SECURITY.md promises.
6. If the public repository isn't `github.com/aethenoxai/jobScraper`, update the clone URL in README.md and docs/INSTALL.md and the `repository`, `homepage` and `bugs` fields in package.json.

## Every release

1. All gates green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and the offline evals (`pnpm eval:matching --offline`, `pnpm eval:tailoring --offline`, `pnpm eval:inbox --offline`). With a provider key, also run the AI evals.
2. Fresh-install check, native and Docker, following only README.md.
3. Update CHANGELOG.md and the version in package.json.
4. Tag `v<version>` and push the tag; create a GitHub release with the changelog section.

Database changes ship as new files in `drizzle/`. Never edit a migration that is already in a release.

Upgrading Scrapling: change the version in `python/requirements.txt`, replace `.claude/skills/scrapling-official/` with the `agent-skill/Scrapling-Skill` folder from the same Scrapling tag, and check the helper against that version's API (`python/scrapling_helper.py`: session options, `Response` fields, `_detect_cloudflare`). Run `pytest python/tests` and the integration tests (`pnpm vitest run src/server/scrapling`).
