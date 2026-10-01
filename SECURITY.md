# Security policy

Job Scraper runs on your own computer and holds sensitive data: your CV, email account access, website sign-ins and API keys. We take reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through GitHub's *Report a vulnerability* button (Security → Advisories) on this repository. Include what you found, how to reproduce it, and the impact you expect.

You'll get a reply within a week. We'll agree on a fix and a disclosure date with you, and credit you unless you'd rather not be named.

## Scope

In scope: anything that lets another website, another user on the same computer, or a job page, email or CV file:

- read or change Job Scraper's data;
- act as the user (send email, apply, sign in somewhere);
- or reach the user's network through Job Scraper (for example, a job page that gets the page reader past its guard proxy to this computer or the local network).

The design assumptions are described in [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/CONFIGURATION.md](docs/CONFIGURATION.md#access-from-other-devices):

- by default only this computer can use the web UI;
- `APP_PASSWORD` protects it on a trusted network, without TLS.

Out of scope:

- exposing the UI to the internet without a TLS proxy;
- running with `JOB_SCRAPER_ALLOW_PRIVATE_URLS`;
- problems in the AI, email or job-site services themselves.

## Supported versions

Security fixes go into the latest release.
