# simple-status

A small, free-to-host status page with an admin UI and a REST API, running on
Cloudflare Workers and D1. It replaces Server Status v2 and is **not** backwards
compatible with it.

- **Public page** (`/`): the overall status is the headline, on a background in
  its colour, so it's clear at a glance. Below it are the services, current and
  scheduled incidents, and a timeline of past incidents that loads more as you
  scroll. It refreshes every 60 s, shows times relative and in the visitor's time
  zone, and has a light/dark/auto theme switch. Each incident has its own page.
- **Read API** (`/api/v1`): JSON, no auth.
- **Admin** (`/admin`): manage services and incidents. Protected by
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/);
  the app has no login code of its own.

## How status works

An incident has an `impact`: `maintenance`, `minor_outage` or `major_outage`.
Planned maintenance is just an incident with impact `maintenance`. There is no
status field to keep in sync. Whether an incident is `upcoming`, `active` or `ended`
follows from `starts_at` and `ends_at`, so maintenance windows start and end on
their own, and resolving an incident means setting `ends_at`.

Each incident has its own timeline: **Started** (its start time and description), then
any **updates** admins post (**Identified**, **Monitoring**, **Update**, **Ended**), then **Ended**
(its end time). Incidents in the API include their `updates`, newest first.

A service's status is the worst impact among the active incidents affecting it, or
`operational`. The banner shows the worst service status.

## API

All responses are JSON. Errors are `application/problem+json`
([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)); validation errors list each
problem in `errors`. Times are ISO 8601. Any offset is accepted on input, and output
is always UTC.

| Method | Path                                                               |                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/status`                                                   | Overall status, services with their status, active and upcoming incidents                                                                                                                     |
| GET    | `/api/v1/services`, `/api/v1/services/{id}`                        | Services                                                                                                                                                                                      |
| GET    | `/api/v1/incidents?state=upcoming\|active\|ended&limit=20&cursor=` | Incidents, newest first (upcoming: soonest first). `limit` is capped at 50; pass `next_cursor` back as `cursor` for the next page.                                                            |
| GET    | `/api/v1/incidents/{id}`                                           | One incident                                                                                                                                                                                  |
| POST   | `/admin/api/v1/services`                                           | `{ name, description?, position? }`. New services go last.                                                                                                                                    |
| PATCH  | `/admin/api/v1/services/{id}`                                      | Any of the fields above                                                                                                                                                                       |
| DELETE | `/admin/api/v1/services/{id}`                                      | 409 while incidents refer to the service                                                                                                                                                      |
| PUT    | `/admin/api/v1/services/order`                                     | `{ ids }`: every service id once, in the new order                                                                                                                                            |
| POST   | `/admin/api/v1/incidents`                                          | `{ title, impact, service_ids, body?, starts_at?, ends_at? }`. `starts_at` defaults to now. Maintenance needs `ends_at`; outages can only have a past `ends_at` (they end when you end them). |
| PATCH  | `/admin/api/v1/incidents/{id}`                                     | Any of the fields above, e.g. `{ "ends_at": "…" }` to resolve                                                                                                                                 |
| DELETE | `/admin/api/v1/incidents/{id}`                                     |                                                                                                                                                                                               |
| POST   | `/admin/api/v1/incidents/{id}/updates`                             | `{ status, body }`. `status` is `identified`, `monitoring`, `update` or `ended`, which also ends the incident. To move a planned end, `PATCH` the incident.                                   |
| DELETE | `/admin/api/v1/incidents/{id}/updates/{updateId}`                  |                                                                                                                                                                                               |

Admin requests need a Cloudflare Access token. Writes must be
`Content-Type: application/json`, and requests from another `Origin` are refused.
Scripts can use an
[Access service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

## Development

Requires Node.js 26 (see `.nvmrc`).

```sh
npm ci
cp .dev.vars.example .dev.vars   # disables Access, for localhost only
npm run db:migrate               # local D1
npm run db:seed                  # optional example data
npm run dev                      # http://localhost:8787, admin at /admin
npm run check                    # typecheck, lint, format check, tests
```

`worker-configuration.d.ts` is generated by `npm run cf-typegen` (also run by
`npm run typecheck`) and is not committed. Re-run it after changing
`wrangler.jsonc`.

Layout: `src/status.ts` (status rules), `src/db.ts` (SQL), `src/schemas.ts`
(validation), `src/api.ts` and `src/admin-api.ts` (routes), `src/access.ts` (Access
JWT check), `src/pages/` (HTML), `public/static/` (CSS and the two small scripts),
`migrations/` (D1 schema).

## Deploying your own

Deploy from your own machine or CI, not from the devcontainer sandbox. Its firewall
blocks the Cloudflare API on purpose, and it should never hold a Cloudflare token.

1. `npx wrangler login`
2. `npx wrangler d1 create simple-status`, then add the printed `database_id` to the
   `d1_databases` entry in `wrangler.jsonc`.
3. Set `SITE_NAME` in `wrangler.jsonc`.
4. In Cloudflare Zero Trust, create a self-hosted Access application for
   `<your host>/admin` (this covers `/admin/*` too), with a policy for who may sign in.
5. Set the two secrets:
   - `npx wrangler secret put ACCESS_TEAM_DOMAIN`: for example `myteam.cloudflareaccess.com`.
   - `npx wrangler secret put ACCESS_AUD`: the application's "Application Audience (AUD) Tag".
6. `npm run deploy`. This applies pending migrations, then deploys.

Until both secrets are set, `/admin` answers 503. Back up the database with
`npx wrangler d1 export simple-status --remote --output backup.sql`.

## Docs

- [Design and scope](docs/considerations.md)
- [Plan: architecture, data model, API, milestones](docs/plan.md)
- [Hosting and auth](docs/hosting.md)
- [v2 reference](docs/v2/)
