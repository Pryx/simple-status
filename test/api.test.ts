import { beforeEach, describe, expect, it } from "vitest";
import { createIncident, createService, get, hoursFromNow, mockAccessKeys } from "./helpers";

beforeEach(mockAccessKeys);

describe("GET /api/v1/status", () => {
  it("is operational with nothing going on", async () => {
    const res = await get("/api/v1/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "operational", services: [], incidents: [] });
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

    const body = await (
      await get("/api/v1/status")
    ).json<{
      status: string;
      services: { name: string; status: string }[];
      incidents: { state: string }[];
    }>();
    expect(body.status).toBe("minor_outage");
    expect(body.services.map((s) => [s.name, s.status])).toEqual([
      ["Website", "minor_outage"],
      ["API", "operational"],
    ]);
    expect(body.incidents.map((i) => i.state)).toEqual(["active", "upcoming"]);
  });
});

describe("GET /api/v1/incidents", () => {
  it("filters by state and paginates newest first", async () => {
    const s = await createService();
    const ended = [];
    for (let h = 10; h >= 6; h--) {
      ended.push(
        await createIncident({
          service_ids: [s.id],
          starts_at: hoursFromNow(-h),
          ends_at: hoursFromNow(-h + 1),
        }),
      );
    }
    await createIncident({ service_ids: [s.id] });

    const first = await (
      await get("/api/v1/incidents?state=ended&limit=2")
    ).json<{
      incidents: { id: string; state: string }[];
      next_cursor: string | null;
    }>();
    expect(first.incidents.map((i) => i.id)).toEqual([ended[4]?.id, ended[3]?.id]);
    expect(first.incidents.every((i) => i.state === "ended")).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const ids: string[] = first.incidents.map((i) => i.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await (
        await get(`/api/v1/incidents?state=ended&limit=2&cursor=${cursor}`)
      ).json<{
        incidents: { id: string }[];
        next_cursor: string | null;
      }>();
      ids.push(...page.incidents.map((i) => i.id));
      cursor = page.next_cursor;
    }
    expect(ids).toEqual(ended.map((i) => i.id).reverse());

    const active = await (
      await get("/api/v1/incidents?state=active")
    ).json<{ incidents: unknown[] }>();
    expect(active.incidents).toHaveLength(1);
  });

  it("caps limit at 50 and rejects bad input", async () => {
    expect((await get("/api/v1/incidents?limit=1000")).status).toBe(200);

    const bad = await get("/api/v1/incidents?state=open&limit=0");
    expect(bad.status).toBe(422);
    expect(bad.headers.get("content-type")).toBe("application/problem+json");
    const body = await bad.json<{ errors: { path: string }[] }>();
    expect(body.errors.map((e) => e.path).sort()).toEqual(["limit", "state"]);

    expect((await get("/api/v1/incidents?cursor=%%%")).status).toBe(400);
  });
});

describe("GET /api/v1/incidents/:id", () => {
  it("returns the incident with its services, or 404", async () => {
    const s = await createService();
    const created = await createIncident({ service_ids: [s.id], body: "Details" });

    const res = await get(`/api/v1/incidents/${created.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: created.id,
      title: "Outage",
      body: "Details",
      impact: "major_outage",
      state: "active",
      ends_at: null,
      service_ids: [s.id],
    });

    expect((await get("/api/v1/incidents/nope")).status).toBe(404);
  });
});
