import { beforeEach, describe, expect, it } from "vitest";
import {
  accessToken,
  admin,
  createIncident,
  createService,
  get,
  hoursFromNow,
  mockAccessKeys,
} from "./helpers";

beforeEach(mockAccessKeys);

describe("public pages", () => {
  it("shows the banner, services, incidents and history", async () => {
    const web = await createService("Website");
    await createIncident({ title: "Login broken", impact: "minor_outage", service_ids: [web.id] });
    await createIncident({
      title: "Upgrade",
      impact: "maintenance",
      service_ids: [web.id],
      starts_at: hoursFromNow(24),
      ends_at: hoursFromNow(25),
    });
    await createIncident({
      title: "Old outage",
      service_ids: [web.id],
      starts_at: hoursFromNow(-48),
      ends_at: hoursFromNow(-47),
    });

    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Some systems are degraded");
    // The services overview uses the same badges; only what's going on now pulses.
    expect(html).toContain(
      '<span class="chip impact status-minor_outage live">Minor outage</span>',
    );
    expect(html).toContain('<span class="chip impact status-maintenance">Maintenance</span>');
    expect(html).toContain("Website");
    expect(html).toContain("Login broken");
    expect(html).toContain("Upgrade");
    expect(html).toContain("Old outage");
  });

  it("renders Markdown safely", async () => {
    const s = await createService();
    const incident = await createIncident({
      service_ids: [s.id],
      body: "**bold** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com) ![i](https://evil.example/i.png)",
    });
    const html = await (await get(`/incidents/${incident.id}`)).text();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("<img");
  });

  it("escapes titles", async () => {
    const s = await createService('<b>"svc"</b>');
    await createIncident({ title: "<img src=x onerror=alert(1)>", service_ids: [s.id] });
    const html = await (await get("/")).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>");
  });

  it("shows the latest month of history, and older months on their own pages", async () => {
    const s = await createService();
    for (const [month, day] of [
      ["2026-02", 3],
      ["2026-02", 9],
      ["2026-01", 15],
    ] as const) {
      await createIncident({
        title: `Outage ${month}-${String(day)}`,
        service_ids: [s.id],
        starts_at: `${month}-0${String(day % 10)}T10:00:00Z`,
        ends_at: `${month}-0${String(day % 10)}T11:00:00Z`,
      });
    }
    const home = await (await get("/")).text();
    expect(home).toContain("February 2026");
    expect(home.match(/<li class="status-/g)).toHaveLength(2);
    const next = /href="(\/history\/[^"]+)" data-load-more/.exec(home)?.[1];
    expect(next).toBe("/history/2026-01");

    const older = await (await get(next ?? "")).text();
    expect(older).toContain("January 2026");
    expect(older).toContain("Outage 2026-01-15");
    expect(older).not.toContain("data-load-more");
  });

  it("shows each incident's timeline, newest first, with Started and the description last", async () => {
    const s = await createService("Website");
    const incident = await createIncident({
      title: "Login broken",
      impact: "minor_outage",
      service_ids: [s.id],
      body: "Users cannot log in.",
    });
    for (const n of [1, 2, 3, 4]) {
      await admin("POST", `/incidents/${incident.id}/updates`, {
        status: n === 4 ? "monitoring" : "identified",
        body: `Update number ${String(n)}`,
      });
    }

    const home = await (await get("/")).text();
    const card = home.slice(home.indexOf("Login broken"));
    expect(card).toContain(
      '<span class="chip impact status-minor_outage live">Minor outage</span>',
    );
    expect(card).toContain('<span class="chip">Website</span>');
    // The newest three entries, a link to the rest, then Started with the description.
    const order = [
      "Update number 4",
      "Update number 3",
      "Update number 2",
      "1 more update",
      "Started",
      "Users cannot log in.",
    ];
    const positions = order.map((text) => card.indexOf(text));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(card).not.toContain("Update number 1");
    expect(card).toMatch(/class="entry current"><p class="entry-meta"><strong>Monitoring/);

    const page = await (await get(`/incidents/${incident.id}`)).text();
    expect(page).toContain("Update number 1");
    expect(page).not.toContain("more update");
  });

  it("shows Ended from the end time, and the planned end of current maintenance", async () => {
    const s = await createService();
    const ended = await createIncident({
      service_ids: [s.id],
      starts_at: hoursFromNow(-3),
      ends_at: hoursFromNow(-1),
    });
    const html = await (await get(`/incidents/${ended.id}`)).text();
    expect(html).toMatch(/class="entry current"><p class="entry-meta"><strong>Ended/);

    const maintenance = await createIncident({
      impact: "maintenance",
      service_ids: [s.id],
      starts_at: hoursFromNow(-1),
      ends_at: hoursFromNow(1),
    });
    const page = await (await get(`/incidents/${maintenance.id}`)).text();
    expect(page).toMatch(/class="entry future"><p class="entry-meta"><strong>Expected end/);
    expect(page).toMatch(/class="entry current"><p class="entry-meta"><strong>Started/);
  });

  it("shows Ended at the end time, with the Ended update's message", async () => {
    const s = await createService();
    const incident = await createIncident({ service_ids: [s.id] });
    await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "ended",
      body: "All fixed now.",
    });
    const html = await (await get(`/incidents/${incident.id}`)).text();
    expect(html).toMatch(
      /class="entry current"><p class="entry-meta"><strong>Ended<\/strong> <time[^>]*>[^<]*<\/time><\/p><div class="body"><p>All fixed now.<\/p>/,
    );
    expect(html.match(/<strong>Ended<\/strong>/g)).toHaveLength(1);
  });

  it("orders upcoming maintenance's entries by time", async () => {
    const s = await createService();
    const incident = await createIncident({
      impact: "maintenance",
      service_ids: [s.id],
      starts_at: hoursFromNow(24),
      ends_at: hoursFromNow(25),
    });
    await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "update",
      body: "Moved by a day",
    });
    const html = await (await get(`/incidents/${incident.id}`)).text();
    const order = ["Expected end", "Starts", "Moved by a day"].map((t) => html.indexOf(t));
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("lists more than two services behind one chip", async () => {
    const [a, b, c, d] = [
      await createService("Web"),
      await createService("API"),
      await createService("DB"),
      await createService("Mail"),
    ];
    const ids = (list: ({ id: string } | undefined)[]) => list.map((x) => x?.id ?? "");
    const two = await createIncident({ title: "Two", service_ids: ids([a, b]) });
    const three = await createIncident({ title: "Three", service_ids: ids([c, a, b]) });
    const all = await createIncident({ title: "All", service_ids: ids([a, b, c, d]) });

    const page = async (id: string) => (await get(`/incidents/${id}`)).text();
    const twoHtml = await page(two.id);
    expect(twoHtml).toContain('<span class="chip">Web</span><span class="chip">API</span>');
    expect(twoHtml).not.toContain("services-more");

    // In service order, whatever order they were given in.
    expect(await page(three.id)).toContain(
      '<details class="services-more"><summary class="chip">3 services</summary><ul class="services-popover"><li>Web</li><li>API</li><li>DB</li></ul></details>',
    );
    expect(await page(all.id)).toContain('<summary class="chip">All services</summary>');
  });

  it("returns 404 for unknown incidents", async () => {
    expect((await get("/incidents/nope")).status).toBe(404);
  });
});

describe("admin pages", () => {
  it("links every dashboard card to its edit page", async () => {
    const s = await createService();
    const ongoing = await createIncident({ service_ids: [s.id] });
    const headers = { "Cf-Access-Jwt-Assertion": await accessToken() };
    const html = await (await get("/admin", { headers })).text();
    expect(html).toContain(
      `class="button small edit-button" href="/admin/incidents/${ongoing.id}"`,
    );
  });

  it("posts updates from a composer, with Ended only once started, and no End now", async () => {
    const s = await createService();
    await createIncident({ title: "Ongoing", service_ids: [s.id] });
    await createIncident({
      title: "Planned",
      impact: "maintenance",
      service_ids: [s.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    const html = await (await get("/admin")).text();
    expect(html).not.toContain("End now");
    const [ongoing = "", planned = ""] = ["Ongoing", "Planned"].map((title) => {
      const start = html.indexOf(`>${title}</a>`);
      return html.slice(start, html.indexOf("</article>", start));
    });
    expect(ongoing).toContain('<form method="post" class="composer"');
    expect(ongoing).toContain('value="ended"');
    expect(planned).toContain('value="update"');
    expect(planned).not.toContain('value="ended"');
  });

  it("records who changed what, on the incident and on the Activity page", async () => {
    const s = await createService("Website");
    const incident = await createIncident({ title: "Login broken", service_ids: [s.id] });
    await admin("PATCH", `/incidents/${incident.id}`, { title: "Login slow", body: "Details" });
    await admin("POST", `/incidents/${incident.id}/updates`, { status: "identified", body: "x" });

    const page = await (await get(`/admin/incidents/${incident.id}`)).text();
    const activity = page.slice(page.indexOf("<h2>Activity</h2>"));
    for (const text of [
      "<strong>admin@example.com</strong> posted an Identified update",
      "edited the title and description",
      "created the incident",
    ]) {
      expect(activity).toContain(text);
    }

    await admin("DELETE", `/incidents/${incident.id}`);
    const all = await (await get("/admin/activity")).text();
    expect(all).toContain("deleted the incident “Login slow”");
    expect(all).toContain("added the service “Website”");
  });

  it("offers an end time only for maintenance", async () => {
    const s = await createService();
    const outage = await createIncident({ service_ids: [s.id] });
    const maintenance = await createIncident({
      impact: "maintenance",
      service_ids: [s.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    const headers = { "Cf-Access-Jwt-Assertion": await accessToken() };

    const outagePage = await (await get(`/admin/incidents/${outage.id}`, { headers })).text();
    expect(outagePage).toMatch(/<label data-maintenance-only="true" hidden="">/);

    const maintenancePage = await (
      await get(`/admin/incidents/${maintenance.id}`, { headers })
    ).text();
    expect(maintenancePage).toMatch(/<label data-maintenance-only="true">/);
  });

  it("renders the forms", async () => {
    const s = await createService("Website");
    const incident = await createIncident({ service_ids: [s.id] });
    const headers = { "Cf-Access-Jwt-Assertion": await accessToken() };
    for (const path of [
      "/admin",
      "/admin/incidents/new",
      `/admin/incidents/${incident.id}`,
      "/admin/services",
    ]) {
      const res = await get(path, { headers });
      expect(res.status, path).toBe(200);
    }
  });
});
