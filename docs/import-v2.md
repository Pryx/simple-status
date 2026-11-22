# Importing from Server Status v2

`scripts/import-v2.mjs` converts a `mysqldump` of a v2 database into SQL for this one,
and prints a report of anything it changed or left out. The commands are in the
README. Import into an empty database: ids are stable, so a second import fails
instead of duplicating anything. Keep the dump and the SQL out of the repository and
delete them afterwards: they hold your users' data.

## How v2's data maps

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
- **Leftover HTML** in incident texts: `<br>` becomes a line break and links become
  Markdown links; other tags are dropped.
- **Long outages** (over 3 days) are listed in the report, so you can check the end
  time that was derived for them.
