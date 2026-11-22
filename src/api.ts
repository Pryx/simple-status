import { Hono } from "hono";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  getIncident,
  getService,
  type Incident,
  listCurrentIncidents,
  listIncidents,
  listServices,
} from "./db";
import { notFound, validate } from "./problem";
import { listQuery } from "./schemas";
import { serviceStatuses, stateOf, worst } from "./status";
import type { AppEnv } from "./types";

/** The JSON shape of an incident: the stored fields plus its state at `now`. */
export const incidentJson = (incident: Incident, now: string) => ({
  ...incident,
  state: stateOf(incident, now),
});

/** Public, read-only API. */
export const api = new Hono<AppEnv>()
  .get("/status", async (c) => {
    const now = new Date().toISOString();
    const [services, current] = await Promise.all([
      listServices(c.env.DB),
      listCurrentIncidents(c.env.DB, now),
    ]);
    const statuses = serviceStatuses(
      services.map((s) => s.id),
      current,
      now,
    );
    return c.json({
      status: worst(statuses.values()),
      services: services.map((s) => ({ ...s, status: statuses.get(s.id) ?? "operational" })),
      incidents: current.map((i) => incidentJson(i, now)),
    });
  })
  .get("/services", async (c) => c.json({ services: await listServices(c.env.DB) }))
  .get("/services/:id", async (c) => {
    const service = await getService(c.env.DB, c.req.param("id"));
    if (!service) throw notFound();
    return c.json(service);
  })
  .get("/incidents", async (c) => {
    const now = new Date().toISOString();
    const query = validate(listQuery, c.req.query());
    const page = await listIncidents(c.env.DB, {
      state: query.state,
      limit: query.limit,
      after: decodeCursor(query.cursor),
      now,
    });
    return c.json({
      incidents: page.incidents.map((i) => incidentJson(i, now)),
      next_cursor: page.next && encodeCursor(page.next),
    });
  })
  .get("/incidents/:id", async (c) => {
    const incident = await getIncident(c.env.DB, c.req.param("id"));
    if (!incident) throw notFound();
    return c.json(incidentJson(incident, new Date().toISOString()));
  });
