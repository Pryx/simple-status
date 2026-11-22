import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessToken,
  admin,
  BASE,
  createIncident,
  createService,
  get,
  hoursFromNow,
  mockAccessKeys,
} from "./helpers";

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
  it("creates, updates and deletes, reflected in the read API", async () => {
    const res = await admin("POST", "/services", { name: "  API  ", description: "REST" });
    expect(res.status).toBe(201);
    const service = await res.json<{ id: string }>();
    expect(res.headers.get("location")).toBe(`/api/v1/services/${service.id}`);
    expect(await (await get(`/api/v1/services/${service.id}`)).json()).toMatchObject({
      name: "API",
      description: "REST",
      position: 0,
    });

    const patched = await admin("PATCH", `/services/${service.id}`, { position: 3 });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "API", position: 3 });

    expect((await admin("DELETE", `/services/${service.id}`)).status).toBe(204);
    expect((await get(`/api/v1/services/${service.id}`)).status).toBe(404);
    expect((await admin("DELETE", `/services/${service.id}`)).status).toBe(404);
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
      (await (await get("/api/v1/services")).json<{ services: { name: string }[] }>()).services.map(
        (s) => s.name,
      );
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
  it("creates, resolves and deletes, reflected in the read API", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id, service.id] });
    expect(incident.state).toBe("active");
    expect((await (await get("/api/v1/status")).json<{ status: string }>()).status).toBe(
      "major_outage",
    );

    const resolved = await admin("PATCH", `/incidents/${incident.id}`, {
      ends_at: new Date().toISOString(),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ state: "ended", service_ids: [service.id] });
    expect((await (await get("/api/v1/status")).json<{ status: string }>()).status).toBe(
      "operational",
    );

    expect((await admin("DELETE", `/incidents/${incident.id}`)).status).toBe(204);
    expect((await get(`/api/v1/incidents/${incident.id}`)).status).toBe(404);
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

    const outage = await createIncident({ service_ids: [service.id] });

    // A browser clock a minute ahead still ends it, at the server's time.
    const ahead = new Date(Date.now() + 60_000).toISOString();
    const ended = await admin("PATCH", `/incidents/${outage.id}`, { ends_at: ahead });
    expect(ended.status).toBe(200);
    const body = await ended.json<{ state: string; ends_at: string }>();
    expect(body.state).toBe("ended");
    expect(body.ends_at < ahead).toBe(true);
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

  it("adds updates, newest first, and shows them in the read API", async () => {
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

    const read = await (await get(`/api/v1/incidents/${incident.id}`)).json<WithUpdates>();
    expect(read.updates).toEqual(body.updates);
  });

  it("ends the incident with an ended update", async () => {
    const service = await createService();
    const incident = await createIncident({ service_ids: [service.id] });
    const res = await admin("POST", `/incidents/${incident.id}/updates`, {
      status: "ended",
      body: "Fixed",
    });
    const body = await res.json<WithUpdates>();
    expect(body.state).toBe("ended");
    expect(body.ends_at).not.toBeNull();
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
