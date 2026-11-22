import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessToken,
  admin,
  BASE,
  createIncident,
  createService,
  get,
  hoursFromNow,
  mockAccessKeys,
  published,
  publishedJson,
} from "./helpers";

interface Status {
  status: string;
  services: { name: string; description: string; status: string }[];
}

beforeEach(mockAccessKeys);

const ADMIN_ROUTES = [
  ["GET", "/admin"],
  ["GET", "/admin/services"],
  ["GET", "/admin/incidents/new"],
  ["GET", "/admin/does-not-exist"],
  ["POST", "/admin/api/v1/services"],
  ["PATCH", "/admin/api/v1/services/x"],
  ["DELETE", "/admin/api/v1/services/x"],
  ["PUT", "/admin/api/v1/services/order"],
  ["POST", "/admin/api/v1/incidents"],
  ["PATCH", "/admin/api/v1/incidents/x"],
  ["DELETE", "/admin/api/v1/incidents/x"],
  ["POST", "/admin/api/v1/incidents/x/updates"],
  ["DELETE", "/admin/api/v1/incidents/x/updates/y"],
  ["POST", "/admin/api/v1/publish"],
  ["POST", "/admin/api/v1/preview"],
  ["GET", "/"],
  ["GET", "/api/v1/summary"],
] as const;

describe("Access", () => {
  it.each(ADMIN_ROUTES)("refuses %s %s without a token", async (method, path) => {
    const res = await exports.default.fetch(`${BASE}${path}`, { method });
    expect(res.status).toBe(401);
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["wrong audience", { aud: ["someone-else"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
  ])("refuses a token with %s", async (_, claims) => {
    const res = await get("/admin", {
      headers: { "Cf-Access-Jwt-Assertion": await accessToken(claims) },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a token signed with another key", async () => {
    const token = await accessToken();
    const [header, payload] = token.split(".");
    const forged = `${header ?? ""}.${payload ?? ""}.${btoa("not a signature")}`;
    const res = await get("/admin", { headers: { "Cf-Access-Jwt-Assertion": forged } });
    expect(res.status).toBe(401);
  });

  it("doesn't fetch keys for a header that isn't a JWT", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();
    const res = await get("/admin", { headers: { "Cf-Access-Jwt-Assertion": "garbage" } });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid token and shows who is signed in", async () => {
    const res = await get("/admin", {
      headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("admin@example.com");
  });
});

describe("write protection", () => {
  it("refuses cross-origin requests", async () => {
    const res = await exports.default.fetch(`${BASE}/admin/api/v1/services`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessToken(),
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses non-JSON bodies", async () => {
    const res = await exports.default.fetch(`${BASE}/admin/api/v1/services`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessToken(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "name=x",
    });
    expect(res.status).toBe(415);
  });

  it("refuses malformed JSON", async () => {
    const res = await exports.default.fetch(`${BASE}/admin/api/v1/services`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessToken(),
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(res.status).toBe(400);
  });
});

describe("services", () => {
  it("creates, updates and deletes, and publishes the status", async () => {
    const res = await admin("POST", "/services", { name: "  API  ", description: "REST" });
    expect(res.status).toBe(201);
    const service = await res.json<{ id: string }>();
    expect((await publishedJson<Status>("api/v1/summary")).services).toMatchObject([
      { name: "API", description: "REST", status: "operational" },
    ]);

    const patched = await admin("PATCH", `/services/${service.id}`, { position: 3 });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "API", position: 3 });

    expect((await admin("DELETE", `/services/${service.id}`)).status).toBe(204);
    expect((await publishedJson<Status>("api/v1/summary")).services).toEqual([]);
    expect((await admin("DELETE", `/services/${service.id}`)).status).toBe(404);
  });

  it("republishes incident pages when a service is renamed", async () => {
    const service = await createService("Old name");
    const incident = await createIncident({ service_ids: [service.id] });
    expect((await published(`incidents/${incident.id}`))?.text).toContain("Old name");
    await admin("PATCH", `/services/${service.id}`, { name: "New name" });
    expect((await published(`incidents/${incident.id}`))?.text).toContain("New name");
  });

  it("validates input", async () => {
    const res = await admin("POST", "/services", { name: "", extra: 1, position: 1.5 });
    expect(res.status).toBe(422);
    const body = await res.json<{ errors: { path: string }[] }>();
    expect(body.errors.map((e) => e.path).sort()).toEqual(["", "name", "position"]);
  });

  it("adds new services at the end, and reorders them", async () => {
    const a = await createService("A");
    const b = await createService("B");
    const c = await createService("C");
    const names = async () =>
      (await publishedJson<Status>("api/v1/summary")).services.map((s) => s.name);
    expect(await names()).toEqual(["A", "B", "C"]);

    expect((await admin("PUT", "/services/order", { ids: [c.id, a.id, b.id] })).status).toBe(204);
    expect(await names()).toEqual(["C", "A", "B"]);

    // Every service exactly once, or nothing changes.
    for (const ids of [
      [a.id, b.id],
      [a.id, b.id, c.id, c.id],
      [a.id, b.id, "nope"],
    ]) {
      expect((await admin("PUT", "/services/order", { ids })).status).toBe(422);
    }
    expect(await names()).toEqual(["C", "A", "B"]);
  });

  it("refuses to delete a service that incidents refer to", async () => {
    const service = await createService();
    await createIncident({ service_ids: [service.id] });
    expect((await admin("DELETE", `/services/${service.id}`)).status).toBe(409);
  });
});

describe("incidents", () => {
  it("creates, ends and deletes, and publishes the status and the incident", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id, service.id] });
    expect(incident.state).toBe("active");
    expect((await publishedJson<Status>("api/v1/summary")).status).toBe("major_outage");
    expect(await publishedJson(`api/v1/incidents/${incident.id}`)).toMatchObject({
      state: "active",
      service_ids: [service.id],
    });

    const ended = await admin("POST", `/incidents/${incident.id}/updates`, { status: "ended" });
    expect(ended.status).toBe(201);
    expect(await ended.json()).toMatchObject({ state: "ended" });
    expect((await publishedJson<Status>("api/v1/summary")).status).toBe("operational");

    expect((await admin("DELETE", `/incidents/${incident.id}`)).status).toBe(204);
    expect(await published(`api/v1/incidents/${incident.id}`)).toBeNull();
    expect(await published(`incidents/${incident.id}`)).toBeNull();
    expect((await admin("DELETE", `/incidents/${incident.id}`)).status).toBe(404);
  });

  it("replaces the affected services on update", async () => {
    const a = await createService("A");
    const b = await createService("B");
    const incident = await createIncident({ service_ids: [a.id] });
    const res = await admin("PATCH", `/incidents/${incident.id}`, { service_ids: [b.id] });
    expect(await res.json()).toMatchObject({ service_ids: [b.id] });
  });

  it("normalises times to UTC", async () => {
    const service = await createService();
    const incident = await createIncident({
      service_ids: [service.id],
      starts_at: "2026-01-01T12:00:00+02:00",
    });
    expect(incident.starts_at).toBe("2026-01-01T10:00:00.000Z");
  });

  it.each([
    ["no services", { service_ids: [] }, "service_ids"],
    ["an unknown service", { service_ids: ["nope"] }, "service_ids"],
    [
      "an end before the start",
      { starts_at: hoursFromNow(0), ends_at: hoursFromNow(-1) },
      "ends_at",
    ],
    ["maintenance without an end", { impact: "maintenance" }, "ends_at"],
    ["an unknown impact", { impact: "catastrophic" }, "impact"],
    ["a time without an offset", { starts_at: "2026-01-01T10:00:00" }, "starts_at"],
  ])("rejects %s", async (_, fields, path) => {
    const service = await createService();
    const res = await admin("POST", "/incidents", {
      title: "x",
      impact: "major_outage",
      service_ids: [service.id],
      ...fields,
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ errors: { path: string }[] }>();
    expect(body.errors.map((e) => e.path)).toContain(path);
  });

  it("lets only maintenance end in the future", async () => {
    const service = await createService();
    const res = await admin("POST", "/incidents", {
      title: "x",
      impact: "major_outage",
      service_ids: [service.id],
      ends_at: hoursFromNow(1),
    });
    expect(res.status).toBe(422);

    // An end in the past is fine: the outage is over.
    const past = await createIncident({
      service_ids: [service.id],
      starts_at: hoursFromNow(-2),
      ends_at: hoursFromNow(-1),
    });
    expect(past.state).toBe("ended");
  });

  it("drops the planned end when maintenance becomes an outage", async () => {
    const service = await createService();
    const incident = await createIncident({
      impact: "maintenance",
      service_ids: [service.id],
      starts_at: hoursFromNow(-1),
      ends_at: hoursFromNow(1),
    });
    const res = await admin("PATCH", `/incidents/${incident.id}`, { impact: "minor_outage" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ impact: "minor_outage", ends_at: null });

    // Other edits keep it.
    const other = await createIncident({
      impact: "maintenance",
      service_ids: [service.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    const renamed = await admin("PATCH", `/incidents/${other.id}`, { title: "Renamed" });
    expect(await renamed.json()).toMatchObject({ ends_at: other.ends_at });
  });

  it("keeps the start time when a PATCH leaves it out", async () => {
    const service = await createService();
    const incident = await createIncident({
      service_ids: [service.id],
      starts_at: "2026-01-01T10:00:30.500Z",
    });
    const res = await admin("PATCH", `/incidents/${incident.id}`, { title: "Renamed" });
    expect(await res.json()).toMatchObject({ starts_at: "2026-01-01T10:00:30.500Z" });
  });

  it("validates the merged result of a PATCH", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    const res = await admin("PATCH", `/incidents/${incident.id}`, { impact: "maintenance" });
    expect(res.status).toBe(422);
  });
});

describe("incident updates", () => {
  interface WithUpdates {
    state: string;
    ends_at: string | null;
    updates: { id: string; status: string; body: string }[];
  }

  it("adds updates, newest first, and publishes them", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });

    expect(
      (
        await admin("POST", `/incidents/${incident.id}/updates`, {
          status: "identified",
          body: "Looking",
        })
      ).status,
    ).toBe(201);
    const res = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "monitoring",
      body: "  Fix deployed  ",
    });
    expect(res.status).toBe(201);
    const body = await res.json<WithUpdates>();
    expect(body.state).toBe("active");
    expect(body.updates.map((u) => [u.status, u.body])).toEqual([
      ["monitoring", "Fix deployed"],
      ["identified", "Looking"],
    ]);

    const read = await publishedJson<WithUpdates>(`api/v1/incidents/${incident.id}`);
    expect(read.updates).toEqual(body.updates);
  });

  it("ends the incident with an ended update, with or without a message", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    const res = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "ended",
      body: "Fixed",
    });
    const body = await res.json<WithUpdates>();
    expect(body.state).toBe("ended");
    expect(body.ends_at).not.toBeNull();

    // Another "Ended" on an ended incident is a note; the end stays.
    const again = await admin("POST", `/incidents/${incident.id}/updates`, { status: "ended" });
    expect(await again.json()).toMatchObject({ ends_at: body.ends_at });
  });

  it("refuses to end an incident that hasn't started", async () => {
    const service = await createService();
    const incident = await createIncident({
      impact: "maintenance",
      service_ids: [service.id],
      starts_at: hoursFromNow(1),
      ends_at: hoursFromNow(2),
    });
    const res = await admin("POST", `/incidents/${incident.id}/updates`, { status: "ended" });
    expect(res.status).toBe(422);
    expect((await res.json<{ detail: string }>()).detail).toContain("hasn't started");

    // Other updates are fine, and don't touch the planned end.
    const note = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "update",
      body: "Moved to tomorrow",
    });
    expect(await note.json()).toMatchObject({ state: "upcoming", ends_at: incident.ends_at });
  });

  it("reopens an outage when its Ended update is deleted", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    const res = await admin("POST", `/incidents/${incident.id}/updates`, { status: "ended" });
    const [ended] = (await res.json<WithUpdates>()).updates;
    await admin("DELETE", `/incidents/${incident.id}/updates/${ended?.id ?? ""}`);
    expect(await publishedJson(`api/v1/incidents/${incident.id}`)).toMatchObject({
      state: "active",
      ends_at: null,
    });
  });

  it("moves the end of maintenance by editing the incident, not with an update", async () => {
    const service = await createService();
    const incident = await createIncident({
      impact: "maintenance",
      service_ids: [service.id],
      starts_at: hoursFromNow(-1),
      ends_at: hoursFromNow(1),
    });
    const later = hoursFromNow(3);
    const withEnd = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "update",
      body: "Taking longer than planned",
      ends_at: later,
    });
    expect(withEnd.status).toBe(422);

    const moved = await admin("PATCH", `/incidents/${incident.id}`, { ends_at: later });
    expect(await moved.json()).toMatchObject({ ends_at: later, state: "active" });
  });

  it("validates input and refuses unknown incidents", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    expect(
      (
        await admin("POST", `/incidents/${incident.id}/updates`, {
          status: "monitoring",
          body: " ",
        })
      ).status,
    ).toBe(422);
    expect(
      (await admin("POST", `/incidents/${incident.id}/updates`, { body: "x", status: "resolved" }))
        .status,
    ).toBe(422);
    expect(
      (await admin("POST", "/incidents/nope/updates", { status: "monitoring", body: "x" })).status,
    ).toBe(404);
  });

  it("deletes updates, and deletes them with their incident", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    const res = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "monitoring",
      body: "x",
    });
    const [update] = (await res.json<WithUpdates>()).updates;

    expect(
      (await admin("DELETE", `/incidents/${incident.id}/updates/${update?.id ?? ""}`)).status,
    ).toBe(204);
    expect(
      (await admin("DELETE", `/incidents/${incident.id}/updates/${update?.id ?? ""}`)).status,
    ).toBe(404);

    await admin("POST", `/incidents/${incident.id}/updates`, { status: "monitoring", body: "y" });
    expect((await admin("DELETE", `/incidents/${incident.id}`)).status).toBe(204);
  });
});

describe("Markdown preview", () => {
  it("renders the way the public site does", async () => {
    const res = await admin("POST", "/preview", { body: "**hi** <b>x</b> [a](//evil.example)" });
    const { html } = await res.json<{ html: string }>();
    expect(html).toContain("<strong>hi</strong>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain('href="//evil.example"');
  });
});
