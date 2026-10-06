# Writing a job-source adapter

A job source (a job board, an applicant-tracking system's public API, an aggregator) is an **adapter**: one file that knows how to fetch that source's jobs and turn them into listings. Everything else is shared: scheduling, politeness, de-duplication across sources, change detection, expiry, matching and the UI.

## The contract

An adapter implements `JobSourceAdapter` from `src/server/sources/types.ts`:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, e.g. `remotive`. Stored with each source; never change it. |
| `displayName`, `description`, `homepage`, `terms` | Shown in the UI. Put the source's usage terms (rate limits, attribution) in `terms`. |
| `configFields`, `configSchema` | What a user enters to add one (e.g. a company's board name). Validated with Zod. Use `{}` if there is nothing to configure. |
| `identityKey` | The config field that identifies one board, so the same board isn't added twice. |
| `completeSnapshot` | `true` if every fetch returns the source's complete current list. Then a job missing from three successful runs is marked expired. Use `false` for search results or partial feeds. |
| `minIntervalMinutes` | The scanner never fetches more often than this. Respect the source's terms. |
| `requiresEnv` | Environment variables it needs, such as an API key. Without them the source is skipped with a clear message. |
| `defaultInstances` | Sources created on first start, so they work with no setup. Only for sources that need no key and allow it. |
| `capabilities` | What the *Job sources* catalog may claim about it. Only the ones the code really does. |
| `fetch(ctx)` | An async generator yielding `RawListing`s. |

`fetch` receives:

- `config`: the validated configuration;
- `http`: the shared HTTP client (timeouts, retries, polite pacing, private-address protection, `Retry-After`);
- `pages`: the page reader, for adapters that read web pages rather than an API (web discovery). It drives Scrapling's stealth browser through a guard proxy that refuses this computer, the local network and the never-read sites. `pages.fetchPage(url, { signal })` returns `{ html, finalUrl, status }` or throws `PageFetchError` (`NOT_INSTALLED`, `REFUSED`, `BLOCKED`, `TIMEOUT`, `HTTP_ERROR`, `HELPER_FAILED`). It is missing when Scrapling isn't set up: fail with `SourceError('SOURCE_CONFIG', SCRAPLING_MISSING)`;
- `signal`: stop when it fires;
- `hints`: the titles, locations and keywords users are looking for, for sources that can search;
- `knownIds`: ids already stored, to skip re-fetching details;
- `env`, `ai` and `log`.

Each `RawListing` has:

- `sourceJobId`: stable for the same job on this source;
- `sourceUrl`;
- `title` and `company`;
- `description`: plain text (use `htmlToText` from `adapters/shared.ts`);
- optional fields: `applicationUrl`, `applyEmail`, `location`, `workMode`, `employmentType`, `salaryText`, `postedAt` and `expiresAt`.

The schema is `RawListingSchema`. Invalid listings are counted as unreadable and skipped; they never crash a scan.

## Rules

- Use the source's **official API or published job data** (JSON feeds, schema.org `JobPosting`) where there is one. Don't bypass logins, rate limits or `robots.txt`.
- Never add LinkedIn, Indeed, Glassdoor and similar sites; their terms forbid automated access.
- Always use `ctx.http` for APIs and `ctx.pages` for web pages (never `fetch` directly). They enforce timeouts, pacing and the private-network guard. Only `ctx.pages` gets past bot checks; check `robots.txt` before reading a page you found yourself (see `pageGuard` in `discovery/web.ts`).
- Throw `SourceError` (`SOURCE_UNAVAILABLE`, `SOURCE_CONFIG`, `SOURCE_PARSE`, `SOURCE_BLOCKED`, `SOURCE_RATE_LIMITED`) for problems the user should see. `guarded()` in `adapters/shared.ts` converts HTTP errors for you.
- Keep requests bounded: page sizes, page limits, and stop early when `knownIds` shows you've reached jobs you already have.

## Example

`src/server/sources/adapters/remotive.ts` is a complete adapter in about 45 lines:

```ts
export const remotive: JobSourceAdapter<Record<string, never>> = {
  id: 'remotive',
  displayName: 'Remotive',
  description: 'Remote jobs from Remotive (listings appear with a 24-hour delay).',
  homepage: 'https://remotive.com',
  terms: 'Remotive asks API users to fetch at most ~4 times a day and to link back to and credit Remotive.',
  configFields: [],
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  completeSnapshot: false,
  minIntervalMinutes: 360,
  defaultInstances: [{ name: 'Remotive', config: {}, enabled: true }],
  async *fetch({ http, signal }) {
    const data = await guarded(() => http.getJson<{ jobs: RemotiveJob[] }>('https://remotive.com/api/remote-jobs?limit=500', { signal }));
    for (const j of data.jobs ?? []) {
      yield { sourceJobId: String(j.id), sourceUrl: j.url, applicationUrl: j.url, title: j.title.trim(), company: j.company_name.trim(), /* … */ description: htmlToText(j.description ?? '') };
    }
  },
};
```

Register it in `src/server/sources/adapters/index.ts` (`BUILT_IN_ADAPTERS`). It then appears in the platform catalog by itself: nothing in the UI knows about individual platforms.

## Capabilities and the platform catalog

The *Job sources* page is a catalog built from the registry (`src/server/sources/platforms.ts`), not from per-platform UI code. Each entry shows what the connector actually does, so the user is never promised something that isn't implemented.

Two capabilities are derived from the contract and must not be declared by hand:

| Capability | Derived from |
| --- | --- |
| `automaticScan` | every registered adapter that isn't `hidden` |
| `detectsClosedJobs` | `completeSnapshot: true` |

The rest an adapter declares itself, and only if it is true:

| Capability | Means |
| --- | --- |
| `search` | it uses `ctx.hints` to look for the user's target titles |
| `findsBoards` | it calls `ctx.registerSource` to add company boards it finds |
| `readsWebPages` | it reads pages with `ctx.pages` (the stealth browser), so it only runs in the worker |

`addByUrl` and `pasteJob` belong to **manual platforms**: sites with no connector at all (LinkedIn, Indeed, Naukri, Wellfound, …). They are listed in `MANUAL_PLATFORMS` so the user can see the supported way in, and they have no adapter, no config and no fetch path — nothing in the scan loop can reach them. A manual platform gets `addByUrl` only when it is outside `NEVER_FETCH`; a site on that list can only ever be pasted by hand.

Never add an adapter for a site on the never-read list, and never give a platform a capability to make the UI look better.

## Testing a source before saving it

The *Add* form has a **Test** button. It runs the adapter once from the web process with a 15-second limit and reports the first few listings (`src/server/sources/probe.ts`), so a wrong board name is caught before the source is saved. Adapters with `readsWebPages` are never run there — their browser belongs to the worker — and the button says so.


## Testing

1. Save a **trimmed, anonymised** response from the source in `tests/fixtures/sources/<id>/`. Keep a few jobs; replace real people's names and emails with invented ones.
2. Test with the contract helpers from `src/server/sources/testing/contract.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertListingsValid, collect, fixtureHttp } from '../testing/contract';

const fixture = (id: string) => JSON.parse(readFileSync(path.resolve('tests/fixtures/sources', id, 'page.json'), 'utf8'));

it('maps jobs', async () => {
  const out = await collect(remotive, {}, fixtureHttp({ 'remotive.com/api/remote-jobs': fixture('remotive') }));
  assertListingsValid(out); // valid listings, unique sourceJobIds
  expect(out[0]).toMatchObject({ workMode: 'remote' });
});
```

Also cover: an empty result, pagination (and stopping at known ids, if you page), and an error response becoming a `SourceError`. The tests never touch the network.

3. Run `pnpm test src/server/sources`, `pnpm typecheck` and `pnpm lint`.
4. Try it for real: add the source on the *Job sources* page, press *Run now* on *Scheduling*, and check the *System* page.
