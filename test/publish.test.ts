import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueAll, peekQueue } from "../src/db";
import { scheduledPublish } from "../src/publish";
import {
  admin,
  get,
  createIncident,
  createService,
  hoursFromNow,
  mockAccessKeys,
  published,
  publishedJson,
} from "./helpers";

beforeEach(mockAccessKeys);

const runCron = () => scheduledPublish(env);

/** An ended incident that started in `month` ("2026-03"), on day `day`. */
const pastIncident = (serviceId: string, month: string, day = 10) =>
  createIncident({
    title: `Outage ${month}-${String(day)}`,
    service_ids: [serviceId],
    starts_at: `${month}-${String(day).padStart(2, "0")}T10:00:00Z`,
    ends_at: `${month}-${String(day).padStart(2, "0")}T11:00:00Z`,
  });

describe("published status", () => {
  it("is operational with nothing going on", async () => {
    expect((await admin("POST", "/publish", {})).status).toBe(202);
    expect(await publishedJson("api/v1/summary")).toMatchObject({
      status: "operational",
      services: [],
      incidents: [],
    });
    expect(await publishedJson("api/v1/incidents/past")).toEqual({
      month: null,
      incidents: [],
      next: null,
    });
    const home = await published("index.html");
    expect(home?.contentType).toBe("text/html; charset=utf-8");
    expect(home?.text).toContain("All systems operational");
    expect(home?.text).toContain('http-equiv="Content-Security-Policy"');
  });

  it("derives service and overall status from active incidents", async () => {
    const web = await createService("Website");
    const api = await createService("API");
    await createIncident({ impact: "minor_outage", service_ids: [web.id] });
    await createIncident({
      impact: "maintenance",
      service_ids: [api.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });

    const body = await publishedJson<{
      status: string;
      services: { name: string; status: string }[];
      incidents: { state: string }[];
    }>("api/v1/summary");
    expect(body.status).toBe("minor_outage");
    expect(body.services.map((s) => [s.name, s.status])).toEqual([
      ["Website", "minor_outage"],
      ["API", "operational"],
    ]);
    expect(body.incidents.map((i) => i.state)).toEqual(["active", "upcoming"]);
  });

  it("splits services, active and scheduled incidents into their own endpoints", async () => {
    const web = await createService("Website");
    await createIncident({ title: "Now", impact: "minor_outage", service_ids: [web.id] });
    await createIncident({
      title: "Later",
      impact: "maintenance",
      service_ids: [web.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    expect(await publishedJson("api/v1/services")).toMatchObject({
      services: [{ name: "Website", status: "minor_outage" }],
    });
    expect(await publishedJson("api/v1/incidents/active")).toMatchObject({
      incidents: [{ title: "Now", state: "active" }],
    });
    expect(await publishedJson("api/v1/incidents/scheduled")).toMatchObject({
      incidents: [{ title: "Later", state: "upcoming" }],
    });
  });

  it("copies the public assets to the bucket", async () => {
    await admin("POST", "/publish", {});
    await runCron(); // The rest of the queue.
    const css = await env.SITE.get("static/style.css");
    expect(css?.httpMetadata?.contentType).toMatch(/^text\/css/);
  });
});

describe("history by month", () => {
  it("pages past incidents by month, each linking to the next older one", async () => {
    const s = await createService();
    await pastIncident(s.id, "2026-01");
    await pastIncident(s.id, "2026-03", 5);
    await pastIncident(s.id, "2026-03", 20);
    await createIncident({ title: "Ongoing", service_ids: [s.id] });

    // The first page is the latest month; it equals that month's own page.
    const first = await publishedJson<{ month: string; incidents: { title: string }[] }>(
      "api/v1/incidents/past",
    );
    expect(first).toEqual(await publishedJson("api/v1/incidents/past/2026-03"));
    expect(first.month).toBe("2026-03");
    expect(first.incidents.map((i) => i.title)).toEqual(["Outage 2026-03-20", "Outage 2026-03-5"]);
    expect(first).toMatchObject({ next: "/api/v1/incidents/past/2026-01" });
    expect(await publishedJson("api/v1/incidents/past/2026-01")).toMatchObject({ next: null });

    // The home page shows the latest month and links to the next.
    const home = (await published("index.html"))?.text ?? "";
    expect(home).toContain("March 2026");
    expect(home).toContain('href="/history/2026-01" data-load-more');
    expect(home).not.toContain("Ongoing</a></h3></header><ol");
  });

  it("relinks the newer month when a month gains or loses its incidents", async () => {
    const s = await createService();
    await pastIncident(s.id, "2026-01");
    await pastIncident(s.id, "2026-03");
    const feb = await pastIncident(s.id, "2026-02");
    expect(await publishedJson("api/v1/incidents/past/2026-03")).toMatchObject({
      next: "/api/v1/incidents/past/2026-02",
    });

    await admin("DELETE", `/incidents/${feb.id}`);
    expect(await published("api/v1/incidents/past/2026-02")).toBeNull();
    expect(await publishedJson("api/v1/incidents/past/2026-03")).toMatchObject({
      next: "/api/v1/incidents/past/2026-01",
    });
  });
});

describe("publishing progress", () => {
  it("is reported by the API and on the dashboard", async () => {
    const s = await createService();
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]) {
      await pastIncident(s.id, month);
    }
    await admin("POST", "/publish", {});
    const progress = await (
      await admin("GET", "/publish")
    ).json<{
      queued: number;
      total: number;
    }>();
    expect(progress.queued).toBeGreaterThan(0);
    // All pages (home, assets, 5 months, 5 incidents), some published already.
    expect(progress.total).toBe(12);

    const html = await (await get("/admin")).text();
    expect(html).toContain(`${String(progress.queued)} pages left, about a minute`);
    expect(html).toContain(`aria-valuemax="12" aria-valuenow="${String(12 - progress.queued)}"`);

    await runCron();
    expect(await (await admin("GET", "/publish")).json()).toEqual({ queued: 0, total: 0 });
    expect(await (await get("/admin")).text()).toMatch(
      /class="card publish-status"[^>]* hidden=""/,
    );
  });
});

describe("publishing order", () => {
  it("publishes month pages before incident pages, so paging works early", async () => {
    const s = await createService();
    for (const month of ["2026-01", "2026-02"]) await pastIncident(s.id, month);
    await enqueueAll(env.DB, new Date().toISOString());
    const kinds = (await peekQueue(env.DB, 100)).map((e) => e.key.split(":")[0]);
    expect(kinds).toEqual(["home", "assets", "month", "month", "incident", "incident"]);
  });
});

describe("cron job", () => {
  it("re-renders everything after a deploy", async () => {
    const s = await createService();
    await env.DB.prepare(
      `INSERT INTO incidents (id, title, impact, starts_at, ends_at, created_at, updated_at)
       VALUES ('direct', 'Added directly', 'minor_outage', ?1, NULL, ?1, ?1)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO incident_services (incident_id, service_id) VALUES ('direct', ?)",
    )
      .bind(s.id)
      .run();
    expect(await published("incidents/direct")).toBeNull();

    await runCron();
    expect((await published("incidents/direct"))?.text).toContain("Added directly");
  });

  it("publishes maintenance starting and ending on its own", async () => {
    const s = await createService();
    await runCron(); // Records the version and the time.
    const maintenance = await createIncident({
      impact: "maintenance",
      service_ids: [s.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    expect((await publishedJson<{ status: string }>("api/v1/summary")).status).toBe("operational");

    // Move the clock: pretend the last run was before the start, and the start has passed.
    await env.DB.batch([
      env.DB.prepare("UPDATE incidents SET starts_at = ?, ends_at = ? WHERE id = ?").bind(
        hoursFromNow(-0.01),
        hoursFromNow(1),
        maintenance.id,
      ),
      env.DB.prepare("UPDATE site_state SET value = ? WHERE key = 'checked_at'").bind(
        hoursFromNow(-0.02),
      ),
    ]);
    await runCron();
    expect((await publishedJson<{ status: string }>("api/v1/summary")).status).toBe("maintenance");
  });
});

describe("Atom feed", () => {
  it("lists incidents, most recently changed first", async () => {
    const s = await createService();
    await createIncident({ title: "First <one>", service_ids: [s.id] });
    await createIncident({ title: "Second", service_ids: [s.id] });
    const feed = await published("feed.atom");
    expect(feed?.contentType).toBe("application/atom+xml; charset=utf-8");
    const text = feed?.text ?? "";
    expect(text).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(text).toContain("<title>First &lt;one&gt;</title>");
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("First"));
  });
});
