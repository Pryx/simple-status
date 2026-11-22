import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as db from "./db";
import { renderMarkdown } from "./markdown";
import { notFound, ProblemError, validate } from "./problem";
import { incidentJson, pagesOf, republish, scheduledPublish } from "./publish";
import { isLocalhost } from "./local";
import { incidentInput, markdownPreview, serviceInput, serviceOrder, updateInput } from "./schemas";
import { stateOf } from "./status";
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

/** Records who did what, in the activity log and as one structured log line. */
async function record(
  c: Context<AppEnv>,
  action: db.Action,
  subjectId: string | null,
  details: db.ActivityDetails = {},
) {
  const entry = {
    at: new Date().toISOString(),
    actor: c.var.admin,
    action,
    subject_id: subjectId,
    details,
  };
  console.log(JSON.stringify({ event: "admin", ...entry }));
  await db.logActivity(c.env.DB, entry);
}

/** The fields whose values differ between two records. */
function changedFields<T extends object>(before: T, after: T, fields: (keyof T & string)[]) {
  return fields.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
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
    await record(c, "service.created", service.id, { name: service.name });
    await republish(c.env, ["home"]);
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
    await record(c, "services.reordered", null);
    await republish(c.env, ["home"]);
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
    const changed = changedFields(existing, service, ["name", "description", "position"]);
    if (changed.length > 0) await record(c, "service.edited", id, { name: existing.name, changed });
    // Incident pages show service names; the description is only on the home page.
    await republish(c.env, service.name === existing.name ? ["home"] : "all");
    return c.json(service);
  })
  .delete("/services/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await db.getService(c.env.DB, id);
    const result = await db.deleteService(c.env.DB, id);
    if (result === "not_found") throw notFound();
    if (result === "in_use") {
      throw new ProblemError({
        title: "Conflict",
        status: 409,
        detail:
          "Incidents refer to this service. Delete them or remove the service from them first.",
      });
    }
    await record(c, "service.deleted", id, { name: existing?.name ?? id });
    await republish(c.env, ["home"]);
    return c.body(null, 204);
  })

  // Incidents

  .post("/incidents", async (c) => {
    const now = new Date().toISOString();
    const input = validate(incidentInput(now), await readJson(c));
    await checkServicesExist(c, input.service_ids);
    const incident = await db.createIncident(c.env.DB, input, now);
    await record(c, "incident.created", incident.id, { name: incident.title });
    await republish(c.env, pagesOf(incident));
    c.header("Location", `/api/v1/incidents/${incident.id}`);
    return c.json(incidentJson(incident, now), 201);
  })
  .patch("/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await readPatch(c);
    const existing = await db.getIncident(c.env.DB, id);
    if (!existing) throw notFound();
    const now = new Date().toISOString();
    const { title, body, impact, starts_at, service_ids } = existing;
    let { ends_at } = existing;
    // Maintenance turning into an outage drops its planned end: an outage is ongoing
    // until someone ends it. (An end that has passed stays.)
    const nextImpact = patch["impact"] ?? impact;
    if (nextImpact !== "maintenance" && !("ends_at" in patch) && ends_at && ends_at > now) {
      ends_at = null;
    }
    const input = validate(incidentInput(now), {
      ...{ title, body, impact, starts_at, ends_at, service_ids },
      ...patch,
    });
    await checkServicesExist(c, input.service_ids);
    await db.updateIncident(c.env.DB, id, input, now);
    const updated = await db.getIncident(c.env.DB, id);
    if (!updated) throw notFound();
    const changed = changedFields(existing, updated, [
      "title",
      "body",
      "impact",
      "starts_at",
      "ends_at",
      "service_ids",
    ]);
    if (changed.length > 0)
      await record(c, "incident.edited", id, { name: updated.title, changed });
    await republish(c.env, pagesOf(existing, updated));
    return c.json(incidentJson(updated, now));
  })
  .delete("/incidents/:id", async (c) => {
    const existing = await db.getIncident(c.env.DB, c.req.param("id"));
    if (!existing || !(await db.deleteIncident(c.env.DB, existing.id))) throw notFound();
    await record(c, "incident.deleted", existing.id, { name: existing.title });
    await republish(c.env, pagesOf(existing));
    return c.body(null, 204);
  })

  // Incident updates

  .post("/incidents/:id/updates", async (c) => {
    const id = c.req.param("id");
    const input = validate(updateInput, await readJson(c));
    const existing = await db.getIncident(c.env.DB, id);
    if (!existing) throw notFound();
    const now = new Date().toISOString();

    // "Ended" ends the incident now, unless it has already ended.
    let endsAt: string | undefined;
    if (input.status === "ended") {
      const state = stateOf(existing, now);
      if (state === "upcoming") {
        throw new ProblemError({
          title: "Unprocessable Content",
          status: 422,
          detail: "It hasn't started yet. To cancel it, delete it; to move it, edit its times.",
        });
      }
      if (state === "active") endsAt = now;
    }

    await db.addIncidentUpdate(c.env.DB, id, input, endsAt, now);
    const updated = await db.getIncident(c.env.DB, id);
    if (!updated) throw notFound();
    await record(c, "update.posted", id, { name: updated.title, status: input.status });
    await republish(c.env, pagesOf(updated));
    c.header("Location", `/api/v1/incidents/${id}`);
    return c.json(incidentJson(updated, now), 201);
  })
  .delete("/incidents/:id/updates/:updateId", async (c) => {
    const id = c.req.param("id");
    const updateId = c.req.param("updateId");
    const now = new Date().toISOString();
    const existing = await db.getIncident(c.env.DB, id);
    const update = existing?.updates.find((u) => u.id === updateId);
    if (!existing || !update || !(await db.deleteIncidentUpdate(c.env.DB, id, updateId, now))) {
      throw notFound();
    }
    await record(c, "update.deleted", id, { name: existing.title, status: update.status });
    await republish(c.env, pagesOf(existing));
    return c.body(null, 204);
  })

  // Publishing and previews

  /**
   * How many pages are waiting to be published. Locally there is no cron job, so each
   * check (the dashboard's progress bar polls it) publishes a batch first.
   */
  .get("/publish", async (c) => {
    if (isLocalhost(c.req.url)) await scheduledPublish(c.env);
    return c.json(await db.queueProgress(c.env.DB));
  })
  /** Re-renders the whole public site. */
  .post("/publish", async (c) => {
    await record(c, "site.republished", null);
    await republish(c.env, "all");
    return c.json({ queued: await db.queueLength(c.env.DB) }, 202);
  })
  /** Renders Markdown the way the public site will. */
  .post("/preview", async (c) => {
    const { body } = validate(markdownPreview, await readJson(c));
    return c.json({ html: renderMarkdown(body) });
  });
