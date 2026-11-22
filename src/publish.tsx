/**
 * The public site is static: HTML, JSON and an Atom feed in an R2 bucket, served from
 * Cloudflare's cache on the public hostname. Visitors never run the Worker, so traffic
 * doesn't count against the Workers or D1 free tiers.
 *
 * Writes queue the pages they affect (`publish_queue`) and publish a few right away.
 * A cron job, every minute, publishes the rest, re-renders pages whose incidents
 * started or ended on their own (a maintenance window), and re-renders everything
 * after a deploy.
 */
import type { JSX } from "hono/jsx/jsx-runtime";
import type { HtmlEscapedString } from "hono/utils/html";
import * as db from "./db";
import type { Incident, Service } from "./db";
import { feed } from "./feed";
import { HomePage, IncidentPage, MonthPage, type SiteInfo } from "./pages/public";
import { serviceStatuses, stateOf, worst } from "./status";

/** Pages published within an admin request; the cron job does the rest. */
export const PUBLISH_NOW = 8;
/** Pages per cron run. Small, to stay well within the free plan's CPU time. */
export const PUBLISH_PER_RUN = 25;

/** The public site's static files, copied from the Worker's assets into the bucket. */
export const PUBLIC_ASSETS = ["static/style.css", "static/app.js", "static/site.js"];

/** A file under public/, as configured: "static/logo.svg" (a leading slash is allowed). */
const assetPath = (path: string) => path.trim().replace(/^\/+/, "");

/** The logo from SITE_LOGO (and SITE_LOGO_DARK), if one is set. */
export function logoOf(env: Env): SiteInfo["logo"] {
  const light = assetPath(env.SITE_LOGO);
  if (!light) return undefined;
  return { light, dark: assetPath(env.SITE_LOGO_DARK) || undefined };
}

// Edges keep a copy for 30 s; browsers check back every time (and usually get a 304).
const PAGE_CACHE = "public, max-age=0, s-maxage=30";
const ASSET_CACHE = "public, max-age=300";

const HTML = { contentType: "text/html; charset=utf-8", cacheControl: PAGE_CACHE };
const JSON_TYPE = { contentType: "application/json; charset=utf-8", cacheControl: PAGE_CACHE };
const ATOM = { contentType: "application/atom+xml; charset=utf-8", cacheControl: PAGE_CACHE };

/** The JSON shape of an incident: the stored fields plus its state at `now`. */
export const incidentJson = (incident: Incident, now: string) => ({
  ...incident,
  state: stateOf(incident, now),
});

const incidentKeys = (id: string) => [`incidents/${id}`, `api/v1/incidents/${id}`];
const monthKeys = (month: string) => [`history/${month}`, `api/v1/incidents/past/${month}`];

/** The API's page of past incidents for `month`: the files are the pagination. */
const pastUrl = (month: string | null) => month && `/api/v1/incidents/past/${month}`;

/** One page of past incidents: a month, and a link to the next (older) page. */
const pastPage = (
  month: string | null,
  incidents: Incident[],
  older: string | null,
  now: string,
) => ({
  month,
  incidents: incidents.map((i) => incidentJson(i, now)),
  next: pastUrl(older),
});

/** Our components are synchronous, so this is a plain string. */
const render = (page: JSX.Element): string => (page as HtmlEscapedString).toString();

class Publisher {
  constructor(
    private readonly env: Env,
    private readonly site: SiteInfo,
  ) {}

  private put(key: string, body: string, httpMetadata: R2HTTPMetadata) {
    return this.env.SITE.put(key, body, { httpMetadata });
  }

  async home() {
    const { DB } = this.env;
    const { now, services } = this.site;
    const [current, month, recent] = await Promise.all([
      db.listCurrentIncidents(DB, now),
      db.monthBefore(DB, null, now),
      db.listRecentlyUpdated(DB, 20),
    ]);
    const [past, older] = month
      ? await Promise.all([db.listMonth(DB, month, now), db.monthBefore(DB, month, now)])
      : [[], null];
    const statuses = serviceStatuses(
      services.map((s) => s.id),
      current,
      now,
    );
    const overall = worst(statuses.values());

    const page = (
      <HomePage
        site={this.site}
        overall={overall}
        statuses={statuses}
        current={current}
        month={month}
        past={past}
        older={older}
      />
    );
    const withStatus = services.map((s) => ({
      ...s,
      status: statuses.get(s.id) ?? "operational",
    }));
    const byState = (state: string) =>
      current.filter((i) => stateOf(i, now) === state).map((i) => incidentJson(i, now));
    // A summary in one request (for widgets), and the same data split up.
    const status = {
      status: overall,
      services: withStatus,
      incidents: current.map((i) => incidentJson(i, now)),
      generated_at: now,
    };
    const json = (key: string, body: unknown) => this.put(key, JSON.stringify(body), JSON_TYPE);
    await Promise.all([
      this.put("index.html", render(page), HTML),
      json("api/v1/summary", status),
      json("api/v1/services", { services: withStatus }),
      json("api/v1/incidents/active", { incidents: byState("active") }),
      json("api/v1/incidents/scheduled", { incidents: byState("upcoming") }),
      json("api/v1/incidents/past", pastPage(month, past, older, now)),
      this.put("feed.atom", feed(this.site, recent, this.env.SITE_URL), ATOM),
    ]);
  }

  async incident(id: string) {
    const incident = await db.getIncident(this.env.DB, id);
    if (!incident) {
      await this.env.SITE.delete(incidentKeys(id));
      return;
    }
    const [html, json] = incidentKeys(id) as [string, string];
    await Promise.all([
      this.put(html, render(<IncidentPage site={this.site} incident={incident} />), HTML),
      this.put(json, JSON.stringify(incidentJson(incident, this.site.now)), JSON_TYPE),
    ]);
  }

  /**
   * A month of history. The next newer month is re-rendered too: its "Load more" link
   * points at the latest month before it, which this change may have created or emptied.
   */
  async month(month: string, withNewer = true) {
    const { DB } = this.env;
    const { now } = this.site;
    const [incidents, older, newer] = await Promise.all([
      db.listMonth(DB, month, now),
      db.monthBefore(DB, month, now),
      withNewer ? db.monthAfter(DB, month, now) : null,
    ]);
    const [html, json] = monthKeys(month) as [string, string];
    if (incidents.length === 0) {
      await this.env.SITE.delete([html, json]);
    } else {
      const page = <MonthPage site={this.site} month={month} incidents={incidents} older={older} />;
      const body = pastPage(month, incidents, older, now);
      await Promise.all([
        this.put(html, render(page), HTML),
        this.put(json, JSON.stringify(body), JSON_TYPE),
      ]);
    }
    if (newer) await this.month(newer, false);
  }

  async assets() {
    const logo = this.site.logo;
    const files = [...PUBLIC_ASSETS, ...(logo ? [logo.light, logo.dark ?? []].flat() : [])];
    await Promise.all(
      files.map(async (path) => {
        const res = await this.env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
        if (!res.ok) throw new Error(`Asset ${path}: ${String(res.status)}`);
        await this.env.SITE.put(path, await res.arrayBuffer(), {
          httpMetadata: {
            contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
            cacheControl: ASSET_CACHE,
          },
        });
      }),
    );
  }

  publish(key: string): Promise<void> {
    if (key === "home") return this.home();
    if (key === "assets") return this.assets();
    const [kind, value = ""] = key.split(/:(.*)/s);
    if (kind === "incident") return this.incident(value);
    if (kind === "month" && /^\d{4}-\d{2}$/.test(value)) return this.month(value);
    return Promise.resolve(); // Unknown key: drop it.
  }
}

/**
 * Publishes up to `limit` queued pages. A page that fails stays queued for the next
 * run; the error is logged, not thrown, since the write that queued it has succeeded.
 * Returns how many pages are still queued.
 */
export async function publishQueued(env: Env, limit: number): Promise<number> {
  const now = new Date().toISOString();
  const entries = await db.peekQueue(env.DB, limit);
  if (entries.length === 0) return 0;
  const services: Service[] = await db.listServices(env.DB);
  const publisher = new Publisher(env, { name: env.SITE_NAME, logo: logoOf(env), now, services });
  const done: db.QueueEntry[] = [];
  for (const entry of entries) {
    try {
      await publisher.publish(entry.key);
      done.push(entry);
    } catch (err) {
      console.error(`Publishing ${entry.key} failed:`, err);
    }
  }
  await db.dequeue(env.DB, done);
  return db.queueLength(env.DB);
}

/** The pages showing an incident: the home page, its own page and its month. */
export function pagesOf(...incidents: ({ id: string; starts_at: string } | null)[]): string[] {
  const keys = ["home"];
  for (const i of incidents) {
    if (i) keys.push(`incident:${i.id}`, `month:${db.monthOf(i.starts_at)}`);
  }
  return keys;
}

/** After a write: queue the affected pages (or all of them) and publish the first few. */
export async function republish(env: Env, pages: string[] | "all"): Promise<void> {
  const now = new Date().toISOString();
  if (pages === "all") await db.enqueueAll(env.DB, now);
  else await db.enqueue(env.DB, pages, now);
  await publishQueued(env, PUBLISH_NOW);
}

/**
 * The cron job. Re-renders everything after a deploy (the templates may have changed)
 * and the pages of incidents that started or ended since the last run, then publishes
 * a batch from the queue.
 */
export async function scheduledPublish(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const [version, checkedAt] = await Promise.all([
    db.getState(env.DB, "version"),
    db.getState(env.DB, "checked_at"),
  ]);
  const deployed = env.CF_VERSION_METADATA.id;

  if (checkedAt === null || version !== deployed) {
    await db.enqueueAll(env.DB, now);
    await db.setState(env.DB, "version", deployed);
  } else {
    const changed = await db.listTransitions(env.DB, checkedAt, now);
    if (changed.length > 0) await db.enqueue(env.DB, pagesOf(...changed), now);
  }
  await db.setState(env.DB, "checked_at", now);
  await publishQueued(env, PUBLISH_PER_RUN);
}

/** Keys of the published site, for the admin's preview. */
export const siteKey = (path: string) => (path === "/" ? "index.html" : path.slice(1));
