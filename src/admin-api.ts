import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { incidentJson } from "./api";
import * as db from "./db";
import { notFound, ProblemError, validate } from "./problem";
import { incidentInput, serviceInput, serviceOrder, updateInput } from "./schemas";
import type { AppEnv } from "./types";

const isJson = (contentType: string | undefined) =>
  contentType !== undefined && /^application\/json\s*(;|$)/i.test(contentType);

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ProblemError({ title: "Bad Request", status: 400, detail: "Malformed JSON." });
  }
}

/** Reads a JSON object body for a partial update. */
async function readPatch(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await readJson(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProblemError({
      title: "Bad Request",
      status: 400,
      detail: "Expected a JSON object.",
    });
  }
  return body as Record<string, unknown>;
}

async function checkServicesExist(c: Context<AppEnv>, ids: readonly string[]) {
  const unknown = await db.unknownServiceIds(c.env.DB, ids);
  if (unknown.length > 0) {
    throw new ProblemError({
      title: "Unprocessable Content",
      status: 422,
      detail: "Some services do not exist.",
      errors: unknown.map((id) => ({ path: "service_ids", message: `Unknown service: ${id}` })),
    });
  }
}

/**
 * Management API. Mounted behind `requireAccess`.
 *
 * Writes accept JSON only and refuse cross-origin requests. Browsers can't send JSON
 * cross-site without a CORS preflight (which this API never approves), so together
 * with the SameSite Access cookie no CSRF token is needed.
 */
export const adminApi = new Hono<AppEnv>()
  .use(async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      throw new ProblemError({ title: "Forbidden", status: 403, detail: "Cross-origin request." });
    }
    if (["POST", "PUT", "PATCH"].includes(c.req.method) && !isJson(c.req.header("Content-Type"))) {
      throw new ProblemError({
        title: "Unsupported Media Type",
        status: 415,
        detail: "Send application/json.",
      });
    }
    await next();
  })
  .use(
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new ProblemError({ title: "Content Too Large", status: 413 });
      },
    }),
  )

  // Services

  .post("/services", async (c) => {
    const input = validate(serviceInput, await readJson(c));
    const service = await db.createService(c.env.DB, input, new Date().toISOString());
    c.header("Location", `/api/v1/services/${service.id}`);
    return c.json(service, 201);
  })
  // Registered before /services/:id so "order" isn't taken for an id.
  .put("/services/order", async (c) => {
    const { ids } = validate(serviceOrder, await readJson(c));
    if (!(await db.reorderServices(c.env.DB, ids, new Date().toISOString()))) {
      throw new ProblemError({
        title: "Unprocessable Content",
        status: 422,
        detail: "ids must list every service exactly once. Reload and try again.",
      });
    }
    return c.body(null, 204);
  })
  .patch("/services/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await readPatch(c);
    const existing = await db.getService(c.env.DB, id);
    if (!existing) throw notFound();
    const { name, description, position } = existing;
    const input = validate(serviceInput, { name, description, position, ...patch });
    const service = await db.updateService(c.env.DB, id, input, new Date().toISOString());
    if (!service) throw notFound();
    return c.json(service);
  })
  .delete("/services/:id", async (c) => {
    const result = await db.deleteService(c.env.DB, c.req.param("id"));
    if (result === "not_found") throw notFound();
    if (result === "in_use") {
      throw new ProblemError({
        title: "Conflict",
        status: 409,
        detail:
          "Incidents refer to this service. Delete them or remove the service from them first.",
      });
    }
    return c.body(null, 204);
  })

  // Incidents

  .post("/incidents", async (c) => {
    const input = validate(incidentInput, await readJson(c));
    await checkServicesExist(c, input.service_ids);
    const now = new Date().toISOString();
    const incident = await db.createIncident(c.env.DB, input, now);
    c.header("Location", `/api/v1/incidents/${incident.id}`);
    return c.json(incidentJson(incident, now), 201);
  })
  .patch("/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await readPatch(c);
    const existing = await db.getIncident(c.env.DB, id);
    if (!existing) throw notFound();
    const { title, body, impact, starts_at, ends_at, service_ids } = existing;
    const input = validate(incidentInput, {
      ...{ title, body, impact, starts_at, ends_at, service_ids },
      ...patch,
    });
    await checkServicesExist(c, input.service_ids);
    const now = new Date().toISOString();
    await db.updateIncident(c.env.DB, id, input, now);
    const updated = await db.getIncident(c.env.DB, id);
    if (!updated) throw notFound();
    return c.json(incidentJson(updated, now));
  })
  .delete("/incidents/:id", async (c) => {
    if (!(await db.deleteIncident(c.env.DB, c.req.param("id")))) throw notFound();
    return c.body(null, 204);
  })

  // Incident updates

  .post("/incidents/:id/updates", async (c) => {
    const id = c.req.param("id");
    const input = validate(updateInput, await readJson(c));
    const existing = await db.getIncident(c.env.DB, id);
    if (!existing) throw notFound();
    const now = new Date().toISOString();

    // "Ended" ends the incident now, unless it already ended. (To move a planned end,
    // PATCH the incident.)
    let endsAt = existing.ends_at;
    if (input.status === "ended" && (endsAt === null || endsAt > now)) endsAt = now;

    // Check the incident's rules (end after start, maintenance has an end) still hold.
    const { title, body, impact, starts_at, service_ids } = existing;
    const merged = validate(incidentInput, {
      ...{ title, body, impact, starts_at, service_ids },
      ends_at: endsAt,
    });

    await db.addIncidentUpdate(c.env.DB, id, input, merged.ends_at, now);
    const updated = await db.getIncident(c.env.DB, id);
    if (!updated) throw notFound();
    c.header("Location", `/api/v1/incidents/${id}`);
    return c.json(incidentJson(updated, now), 201);
  })
  .delete("/incidents/:id/updates/:updateId", async (c) => {
    const deleted = await db.deleteIncidentUpdate(
      c.env.DB,
      c.req.param("id"),
      c.req.param("updateId"),
    );
    if (!deleted) throw notFound();
    return c.body(null, 204);
  });
