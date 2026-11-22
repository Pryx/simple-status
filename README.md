# simple-status

A small, free-to-host status page with an admin UI and a REST API, running on
Cloudflare Workers and D1. It replaces Server Status v2 and is **not** backwards
compatible with it.

- **Public page** (`/`): the overall status is the headline, on a background in
  its colour, so it's clear at a glance. Below it are the services, current and
  scheduled incidents, and a timeline of past incidents, by month, that loads more
  as you scroll. It refreshes every 60 s, shows times relative and in the visitor's
  time zone, and has a light/dark/auto theme switch. Each incident has its own page.
- **Public JSON API** (`/api/v1`) and an **Atom feed** (`/feed.atom`), readable from
  any site (CORS).
- **Admin**: manage services and incidents, with a Markdown editor and a comment-style
  box for status updates. Protected by
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/);
  the app has no login code of its own.

### Free at any traffic

The public site is **static files** in an R2 bucket, served from Cloudflare's cache.
Visitors never run the Worker, so a big outage with thousands of people watching the
page doesn't touch the Workers or D1 free-tier limits. The Worker serves only the
admin, on its own hostname, and publishes the site:

- each admin change re-renders the affected pages right away;
- a cron job every minute renders anything left over, the start and end of scheduled
  maintenance, and the whole site after a deploy.

Pages are cached at the edge for 30 seconds, so changes show up within about half a
minute.

## How status works

An incident has an `impact`: `maintenance`, `minor_outage` or `major_outage`.
Planned maintenance is just an incident with impact `maintenance`. There is no
status field to keep in sync. Whether an incident is `upcoming`, `active` or `ended`
follows from `starts_at` and `ends_at`, so maintenance windows start and end on
their own, and resolving an incident means setting `ends_at`.

Each incident has its own timeline, newest first: **Ended** (its end time, with the
message of the "Ended" update if there is one) or the **Expected end** of maintenance,
the **updates** admins post (**Identified**, **Monitoring**, **Update**), and
**Started** (its start time and description). Posting an **Ended** update ends an
incident; its message is optional. Deleting an outage's Ended update reopens it.
Incidents in the API include their `updates`, newest first.

A service's status is the worst impact among the active incidents affecting it, or
`operational`. The banner shows the worst service status.

## API

### Public (static JSON)

| Path                               |                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/v1/summary`                  | Summary in one request: overall status, services with their status, active and scheduled incidents |
| `/api/v1/services`                 | Services, in display order, with their status                                                      |
| `/api/v1/incidents/active`         | Incidents going on now                                                                             |
| `/api/v1/incidents/scheduled`      | Upcoming incidents and maintenance, soonest first                                                  |
| `/api/v1/incidents/past`           | The first page of past incidents (see below)                                                       |
| `/api/v1/incidents/past/{YYYY-MM}` | Ended incidents that started that month (UTC), newest first                                        |
| `/api/v1/incidents/{id}`           | One incident, with its `state`, `service_ids` and `updates`                                        |
| `/feed.atom`                       | Atom feed of the most recently changed incidents                                                   |

**Pagination:** past incidents come a month per page, as
`{ month, incidents, next }`. `next` is the URL of the next older page (the latest
earlier month with incidents), or `null` on the last page; months without incidents
are skipped. The API is static files, so there are no query parameters: each page is
its own file and only changes when that month does, which keeps it cacheable.

Times are ISO 8601 UTC. Responses allow any origin (CORS), so other sites can show
your status.

### Admin

Errors are `application/problem+json`
([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)); validation errors list each
problem in `errors`. Any time offset is accepted on input.

| Method | Path                                              |                                                                                                                                                                         |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/admin/api/v1/services`                          | `{ name, description?, position? }`. New services go last.                                                                                                              |
| PATCH  | `/admin/api/v1/services/{id}`                     | Any of the fields above                                                                                                                                                 |
| DELETE | `/admin/api/v1/services/{id}`                     | 409 while incidents refer to the service                                                                                                                                |
| PUT    | `/admin/api/v1/services/order`                    | `{ ids }`: every service id once, in the new order                                                                                                                      |
| POST   | `/admin/api/v1/incidents`                         | `{ title, impact, service_ids, body?, starts_at?, ends_at? }`. `starts_at` defaults to now. Maintenance needs `ends_at`; an outage's `ends_at` can only be in the past. |
| PATCH  | `/admin/api/v1/incidents/{id}`                    | Any of the fields above. Changing maintenance into an outage drops its planned end.                                                                                     |
| DELETE | `/admin/api/v1/incidents/{id}`                    |                                                                                                                                                                         |
| POST   | `/admin/api/v1/incidents/{id}/updates`            | `{ status, body }`: `identified`, `monitoring` or `update` with a message, or `ended` (message optional), which ends the incident now. Not before it has started.       |
| DELETE | `/admin/api/v1/incidents/{id}/updates/{updateId}` |                                                                                                                                                                         |
| POST   | `/admin/api/v1/publish`                           | `{}`: re-render the whole public site                                                                                                                                   |
| POST   | `/admin/api/v1/preview`                           | `{ body }`: Markdown rendered as on the public site, `{ html }`                                                                                                         |

The full API is described in [docs/openapi.yaml](docs/openapi.yaml) (OpenAPI 3.1).

Admin requests need a Cloudflare Access token. Writes must be
`Content-Type: application/json`, and requests from another `Origin` are refused.
Scripts can use an
[Access service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

## Development

Requires Node.js 26 (see `.nvmrc`).

```sh
npm ci
cp .dev.vars.example .dev.vars   # disables Access, for localhost only
npm run db:migrate               # local D1, empty
npm run dev                      # http://localhost:8787: the site, admin at /admin

npm run demo:setup               # or: a separate local database with example data
npm run demo                     # the same, on that database
npm run check                    # typecheck, lint, format check, tests
```

Locally there is no cron job, so the preview of the site at `/` publishes pending
pages on each request.

`worker-configuration.d.ts` is generated by `npm run cf-typegen` (also run by
`npm run typecheck`) and is not committed. Re-run it after changing
`wrangler.jsonc`.

Layout: `src/status.ts` (status rules), `src/db.ts` (SQL), `src/schemas.ts`
(validation), `src/admin-api.ts` (admin API), `src/publish.tsx` (renders the site to
R2), `src/feed.ts`, `src/access.ts` (Access JWT check), `src/pages/` (HTML),
`public/static/` (CSS and the small scripts), `migrations/` (D1 schema).

## Deploying your own

Deploy from your own machine or CI, not from the devcontainer sandbox. Its firewall
blocks the Cloudflare API on purpose, and it should never hold a Cloudflare token.

You need a domain on Cloudflare. The examples use `status.example.com` for the public
site and `admin.status.example.com` for the admin. Cloudflare's dashboard changes
from time to time, so check the linked docs if a step doesn't match.

1. `npx wrangler login`
2. **Database:** `npx wrangler d1 create simple-status`, then add the printed
   `database_id` to the `d1_databases` entry in `wrangler.jsonc`.
3. **Bucket:** `npx wrangler r2 bucket create simple-status-site`. (Enabling R2 may
   ask for a payment method, even though this stays within the free tier.)
4. **Public hostname**, in the Cloudflare dashboard:
   - R2 → `simple-status-site` → Settings → Custom Domains: connect
     `status.example.com`.
   - Rules → URL Rewrite: when the hostname is `status.example.com` and the path
     equals `/`, rewrite the path to `/index.html`.
   - Rules → Cache Rules: for `status.example.com`, "Eligible for cache", with Edge
     TTL "Use cache-control header". (By default HTML and JSON aren't cached.)
   - Rules → Response Header Transform: for `status.example.com`, set
     `Strict-Transport-Security: max-age=63072000; includeSubDomains`,
     `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
     `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
   - CORS for the JSON API and feed:
     `npx wrangler r2 bucket cors set simple-status-site --file r2-cors.json`.
5. **Admin hostname:** add it to `wrangler.jsonc`:
   `"routes": [{ "pattern": "admin.status.example.com", "custom_domain": true }]`.
   The `workers.dev` and preview URLs are switched off, so this is the only way in.
6. **Access:** in Cloudflare Zero Trust, create a self-hosted Access application for
   all of `admin.status.example.com`, with a policy for who may sign in.
7. Set `SITE_NAME` (shown at the top of the page), optionally a logo to show instead
   (`SITE_LOGO`, plus `SITE_LOGO_DARK` for dark mode: files you add under `public/`,
   e.g. `static/logo.svg`), and `SITE_URL` (`https://status.example.com`, for the feed), in
   `wrangler.jsonc`.
8. Set the two secrets:
   - `npx wrangler secret put ACCESS_TEAM_DOMAIN`: for example `myteam.cloudflareaccess.com`.
   - `npx wrangler secret put ACCESS_AUD`: the application's "Application Audience (AUD) Tag".
9. `npm run deploy`. This applies pending migrations, then deploys. Within a minute
   the cron job publishes the whole site (or use **Republish site** on the dashboard).

Until both secrets are set, the admin answers 503. Back up the database with
`npx wrangler d1 export simple-status --remote --output backup.sql`; D1's Time Travel
can also restore it to an earlier point (the last 7 days on the free plan).

**Free-tier use:** the cron job runs 1,440 times a day plus your admin use, far below
the Workers and D1 daily limits; public traffic doesn't count. R2 storage is a few
megabytes. Check Cloudflare's current pricing pages for the exact limits.

## Starting over

To empty a database but keep its tables, for example before importing again:

```sh
npx wrangler d1 execute DB --local --file=scripts/wipe.sql     # local
npx wrangler d1 export simple-status --remote --output backup.sql   # production: back up first
npx wrangler d1 execute DB --remote --file=scripts/wipe.sql    # production
```

Locally you can also delete everything, including the local copy of the published
site, and start from scratch: `rm -rf .wrangler/state && npm run db:migrate`. (The
demo database is separate: `npm run demo:setup` resets it.)

After a wipe, the site is republished from the now-empty database within a minute.
Pages of deleted incidents stay in the bucket but are no longer linked; an import
with the same ids overwrites them.

## Moving from Server Status v2

`scripts/import-v2.mjs` converts a v2 database into SQL for this one. It reads a
`mysqldump` of the v2 MySQL database:

```sh
mysqldump --no-tablespaces -u USER -p DATABASE > v2.dump.sql   # on the v2 server
node scripts/import-v2.mjs v2.dump.sql > import.sql             # prints a report
npx wrangler d1 execute DB --local --file=import.sql            # try it locally first
npx wrangler d1 execute DB --remote --file=import.sql           # then the real one
```

Import into an empty database (see [Starting over](#starting-over) to empty one). The
ids are stable, so importing twice fails instead of duplicating anything. The cron job publishes the imported history within a minute.
Both files hold your users' data: keep them out of the repository (`.gitignore` covers
`*.dump.sql` and `import*.sql`) and delete them afterwards.

How v2's data maps:

- **Services** keep v2's order (by group, then name). Groups aren't supported.
- **Incidents without services** (old installs have some) get every service that
  existed at the time, inferred from the ids: v2 doesn't record when a service was
  created.
- **Outages** in v2 had no end time: one stayed in effect for a service until a newer
  post for that service, usually an "Operational" one. An imported outage ends when
  all its services have had such a post. One that never did stays ongoing, as it was
  on the v2 page, and the report lists it so you can end it in the admin.
- **"Operational" posts** become updates on the outages they ended: **Ended** on the
  one they finished, **Update** where they recovered only some of the services.
- **Maintenance** keeps its window.
- **Authors** go into the activity log, as "alice (v2)".
- **Not imported:** staff accounts (sign-in is Cloudflare Access now), subscribers,
  queued notifications and settings. The report tells you v2's site name, for
  `SITE_NAME`.

## Docs

- [Design and scope](docs/considerations.md)
- [Plan: architecture, data model, API, milestones](docs/plan.md)
- [Hosting and auth](docs/hosting.md)
- [v2 reference](docs/v2/)
