# simple-status

A small status page you can host for free on Cloudflare, with an admin UI, a JSON
API and an Atom feed. It replaces Server Status v2 (and can import its data).

- **Status page:** the overall status as the headline on a background in its colour,
  then services, current and scheduled incidents, and past incidents by month with
  infinite scroll. Refreshes itself, shows local times, light and dark themes.
- **Admin:** incidents and maintenance with status updates, a Markdown editor,
  drag-and-drop services, and an activity log. Sign-in is
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).
- **Free at any traffic:** the public site, API and feed are static files in R2,
  served from Cloudflare's cache, so visitors never touch the Workers or D1 limits.
  The Worker serves only the admin and publishes the site after each change (and
  every minute, for maintenance windows that start or end on their own).

**How status works:** an incident has an impact (`maintenance`, `minor_outage` or
`major_outage`) and a start and end time; whether it's upcoming, active or ended
follows from those. A service's status is the worst impact among the active incidents
affecting it. Posting an "Ended" update ends an incident.

**API:** the public JSON API (`/api/v1/…`, readable from any site) and the admin API
are described in [docs/openapi.yaml](docs/openapi.yaml).

## Deploying your own

You need a Cloudflare account with your domain on it. Run this from your own machine,
not from the devcontainer (which should never hold a Cloudflare token).

1. **Once, in the Cloudflare dashboard:**
   - **R2** (storage for the public site): open R2 in the sidebar and enable it. It
     may ask for a payment method; the status page stays within the free tier.
   - **Zero Trust** (the admin's sign-in, via Cloudflare Access):
     - **Already have a team?** Nothing to do. The setup adds one application for
       the admin and leaves your other applications and login methods alone.
     - **Otherwise:** go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com/),
       pick your account, choose a team name (your sign-in page becomes
       `<team>.cloudflareaccess.com`) and the **Free** plan (up to 50 users; it may
       ask for a payment method, but costs nothing).
     - The setup does the rest: the admin's application, who may sign in, and
       one-time codes by email if the team has no login method yet.
2. **Create an API token:** [open the token form with the permissions filled in](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22access_acct%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone_transform_rules%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22transform_rules%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22cache_rules%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22cache_settings%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22memberships%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=simple-status%20setup),
   then check it against the list below and add any that are missing. You can narrow
   "Zone Resources" to your domain. (Or by hand: My Profile → API Tokens → Create
   Token → Create Custom Token.) Copy the token when it's shown: it's shown once.

   | Group   | Permission                                            | Access |
   | ------- | ----------------------------------------------------- | ------ |
   | Account | Workers Scripts                                       | Edit   |
   | Account | D1                                                    | Edit   |
   | Account | Workers R2 Storage                                    | Edit   |
   | Account | Access: Apps and Policies                             | Edit   |
   | Account | Access: Organizations, Identity Providers, and Groups | Edit   |
   | Account | Account Settings                                      | Read   |
   | Zone    | Zone                                                  | Read   |
   | Zone    | DNS                                                   | Edit   |
   | Zone    | Workers Routes                                        | Edit   |
   | Zone    | Transform Rules                                       | Edit   |
   | Zone    | Cache Rules                                           | Edit   |
   | User    | User Details                                          | Read   |
   | User    | Memberships                                           | Read   |

3. **Run the setup:**

   ```sh
   npm ci
   CLOUDFLARE_API_TOKEN=… npm run setup
   ```

   It asks for the status page's address (e.g. `status.example.com`), the admin's
   (e.g. `admin.status.example.com`), the site name and the admins' emails. Then it
   creates the database and storage, connects the address, sets up caching, security
   headers and the admin's sign-in, and deploys. `--dry-run` shows what it would do.
   It's safe to run again (e.g. with `--admins a@example.com,b@example.com`), and
   leaves anything else on your domain alone. You can delete the token afterwards.

The admin is then at `https://admin.status.example.com/admin`. Opening it shows
Cloudflare's sign-in page: an admin enters their email and gets a code to type in.
Only the emails you gave are let in. To change them, run the setup again with
`--admins`, or edit the "simple-status admins" policy in Zero Trust → Access →
Applications.

**Adding or removing admins:** whoever Access lets in is an admin. Either run the
setup again with the complete list (`--admins` replaces it):
`CLOUDFLARE_API_TOKEN=… npm run setup -- --admins a@example.com,b@example.com`. Or in
the dashboard: Zero Trust → Access → Applications → your "… admin" application →
Policies → "simple-status admins" → add or remove emails in the Include rule → Save.

**Afterwards:** `npx wrangler login` once, then `npm run deploy` for updates. (The
first deploy has to be the setup's: it's the one that sets the two Access secrets.)

**Your settings** (database id, addresses, name) are in `wrangler.site.jsonc`, which
git ignores, like `.env.local`: it's merged over the defaults in `wrangler.jsonc`. A
logo goes there too: `"SITE_LOGO": "site/logo.svg"`, and optionally `SITE_LOGO_DARK`,
with the files under `public/site/` (also ignored). For Wrangler commands of your own,
run `npm run site-config` and add `-c wrangler.site.json`.

## Importing from Server Status v2

```sh
mysqldump --no-tablespaces -u USER -p DATABASE > v2.dump.sql    # on the v2 server
node scripts/import-v2.mjs v2.dump.sql > import.sql              # prints a report
npm run site-config
npx wrangler d1 execute DB --remote --file=import.sql -c wrangler.site.json
```

Import into an empty database (try `--local` first). The site republishes within
minutes; the admin dashboard shows the progress. How v2's data is converted:
[docs/import-v2.md](docs/import-v2.md).

## Backups and starting over

```sh
npm run site-config
npx wrangler d1 export simple-status --remote --output backup.sql -c wrangler.site.json
npx wrangler d1 execute DB --remote --file=scripts/wipe.sql -c wrangler.site.json   # empties it
```

`scripts/wipe.sql` deletes all data but keeps the tables (use `--local` for your local
database). D1's Time Travel can also restore an earlier point.

## Development

Requires Node.js 26 (see `.nvmrc`).

```sh
npm ci
cp .dev.vars.example .dev.vars   # local admin without Access (localhost only)
npm run db:migrate
npm run dev                      # http://localhost:8787, admin at /admin
npm run demo:setup && npm run demo   # or: a separate database with example data
npm run check                    # typecheck, lint, format, tests
```

Locally there's no cron job: the site at `/` publishes pending pages on each request.

Code: `src/status.ts` (status rules), `src/db.ts` (SQL), `src/admin-api.ts`,
`src/publish.tsx` (renders the site to R2), `src/pages/` (HTML), `public/static/`
(CSS and small scripts), `migrations/`, `scripts/` (setup, import, config).

More: [plan](docs/plan.md), [hosting](docs/hosting.md),
[design and scope](docs/considerations.md), [v2 reference](docs/v2/).
