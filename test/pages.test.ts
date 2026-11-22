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
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Some systems are degraded");
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

  it("pages past incidents with a Load more link", async () => {
    const s = await createService();
    for (let h = 30; h > 19; h--) {
      await createIncident({
        service_ids: [s.id],
        starts_at: hoursFromNow(-h),
        ends_at: hoursFromNow(-h + 1),
      });
    }
    const first = await (await get("/")).text();
    expect(first.match(/<li class="status-/g)).toHaveLength(10);
    const next = /href="(\/history\?cursor=[^"]+)" data-load-more/.exec(first)?.[1];
    expect(next).toBeDefined();

    const second = await (await get(next ?? "")).text();
    expect(second.match(/<li class="status-/g)).toHaveLength(1);
    expect(second).not.toContain("data-load-more");
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
    expect(card).toContain('<span class="chip impact">Minor outage</span>');
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
