# Rewrite considerations

Inputs for the new version. It is a **personal project and a fresh start**: the v2
organisation repository is archived, and **backwards compatibility is not a goal**.
The v2 docs in this folder describe *what the old app did*. Use them as a feature
reference and as a list of mistakes to avoid, not as a contract.

## First version scope

**As simple as possible:** a REST API for managing and listing incidents (and the
services they affect), a basic public page and a basic admin UI. Everything else
listed below (subscriptions, feeds, groups, i18n, roles, uptime checks) comes later.
The concrete design is in [plan.md](plan.md).

## Goals

- **Free to host,** on infrastructure separate from the monitored services.
  Serverless is the chosen direction: see [hosting.md](hosting.md).
- **Has an admin UI** for managing incidents, services and settings.
- **Clean, simple code with minimal dependencies.**
- **Minimal attack surface.**
- JavaScript is allowed. The no-JS requirement in v2 came from it being a school
  project; it is not a goal now.

## Non-goals

- Running on PHP shared hosting.
- Keeping v2 URLs, API shapes, database schema, configuration or translations.
- Migrating existing installs. An importer for v2 data is optional; see the end of
  this file.

## What to keep from v2 (features)

These are the parts of v2 worth rebuilding (see [v2/features.md](v2/features.md)):

- Services, optionally grouped, each with a current status on the 4-level scale
  (major outage, minor outage, maintenance, operational) and an overall banner.
- Incidents linked to one or more services, with Markdown text.
- Planned maintenance windows shown ahead of time.
- A paginated incident history.
- Email subscriptions per service, with double opt-in. (Telegram is dropped. RSS/Atom
  covers readers who don't want email.)
- Notifications when an incident affects followed services.
- A read-only JSON API.
- Multiple staff users with roles.
- Multiple UI languages.
- Branding: name, logo, footer text and a privacy-policy/imprint page.

## What to do differently

- **Incident lifecycle.** Use *incidents with updates* (investigating → identified →
  monitoring → resolved) instead of "the latest incident sets the status until a
  newer one replaces it". Planned maintenance becomes its own type with a start and
  an end. This is what users of status pages expect, and it removes the "outage
  that never ends" problem.
- **Status derivation.** A service's status comes from its open incidents (the worst
  impact wins), falling back to operational. It never depends on row ordering.
- **Groups.** Either implement collapse/expand properly or drop the setting. The
  group status is the worst status among its services.
- **Times.** Store UTC and render them in the viewer's time zone (client-side).
- **Notification language.** Use the site's default language, or per subscriber
  later.
- **Feeds.** Add RSS/Atom (and maybe webhooks). They are free, need no subscriber
  database, and cover many readers.
- **Configuration.** Secrets live in platform environment variables. Settings that
  are not secrets live in the database and are edited in the admin UI. Secrets are
  never rendered back to the browser.

## Security principles (lessons from the v2 security review)

- No GET request changes state. Every mutation is a POST (or similar) with CSRF
  protection, or is protected by same-site cookies plus an origin check.
- Escape output by default (JSX/templating). Render Markdown in safe mode with a URL
  scheme allowlist.
- **Never** use `LIKE` for token or identifier lookups. Compare tokens in constant time.
- Tokens come from a CSPRNG, are hashed at rest where practical, expire, and are bound
  to their purpose and their user.
- Authorisation is checked per action against the **session user**, in one place.
  No global user objects that code can overwrite.
- Validate every input against a schema (for example with zod): enums, lengths,
  email format, numeric ids.
- Rate-limit login, sign-up and API endpoints. Use Turnstile on public forms.
- Background work runs only from the scheduler. Rows are claimed atomically, and
  retries are bounded.
- Third-party scripts and stylesheets: none on public pages by default. Anything
  necessary is self-hosted, or pinned with SRI.
- There is no installer that can stay reachable. Setup happens at deploy time
  (migrations plus a one-time bootstrap command or invite link).

## Open decisions

1. **Admin auth:** Cloudflare Access as the default with passkeys as the portable
   option (recommended), or passwords. See [hosting.md](hosting.md#admin-authentication).
2. **Roles:** keep three ranks, or simplify to *owner* and *editor*.
3. **Email provider** for subscriber mail, and whether to support generic SMTP.
4. **Frontend styling:** a small CSS file written by hand, or a classless or utility
   framework. Bootstrap 3 and jQuery are not carried over.
5. **i18n:** which languages to start with. The old `.po` files can seed the
   translations, but the strings will differ.
6. **Self-hosting target:** offer a Node/Docker build next to Cloudflare from the
   start, or later.
7. **v2 importer:** build a one-off importer (v2 MySQL dump to the new schema), or skip it.
