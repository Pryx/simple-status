import type { IncidentInput, ServiceInput, UpdateInput } from "./schemas";
import type { Impact, State, UpdateStatus } from "./status";

export interface Service {
  id: string;
  name: string;
  description: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Incident {
  id: string;
  title: string;
  body: string;
  impact: Impact;
  starts_at: string;
  ends_at: string | null;
  service_ids: string[];
  /** Newest first. */
  updates: IncidentUpdate[];
  created_at: string;
  updated_at: string;
}

export interface IncidentUpdate {
  id: string;
  status: UpdateStatus;
  body: string;
  created_at: string;
}

/** Position of an incident in a listing, for keyset pagination. */
export interface Cursor {
  starts_at: string;
  id: string;
}

type IncidentRow = Omit<Incident, "service_ids" | "updates"> & {
  service_ids: string;
  updates: string;
};

const INCIDENT_SELECT = `
  SELECT i.id, i.title, i.body, i.impact, i.starts_at, i.ends_at, i.created_at, i.updated_at,
    (SELECT json_group_array(service_id) FROM incident_services WHERE incident_id = i.id)
      AS service_ids,
    (SELECT json_group_array(json_object(
        'id', id, 'status', status, 'body', body, 'created_at', created_at))
      FROM (SELECT * FROM incident_updates WHERE incident_id = i.id
            ORDER BY created_at DESC, id DESC))
      AS updates
  FROM incidents i`;

function toIncident(row: IncidentRow): Incident {
  return {
    ...row,
    service_ids: (JSON.parse(row.service_ids) as string[]).sort(),
    updates: JSON.parse(row.updates) as IncidentUpdate[],
  };
}

// Services

export async function listServices(db: D1Database): Promise<Service[]> {
  const { results } = await db
    .prepare("SELECT * FROM services ORDER BY position, name, id")
    .all<Service>();
  return results;
}

export function getService(db: D1Database, id: string): Promise<Service | null> {
  return db.prepare("SELECT * FROM services WHERE id = ?").bind(id).first<Service>();
}

export async function createService(
  db: D1Database,
  input: ServiceInput,
  now: string,
): Promise<Service> {
  const service = await db
    .prepare(
      `INSERT INTO services (id, name, description, position, created_at, updated_at)
       VALUES (?, ?, ?, COALESCE(?, (SELECT MAX(position) + 1 FROM services), 0), ?, ?)
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.name, input.description, input.position ?? null, now, now)
    .first<Service>();
  if (!service) throw new Error("INSERT … RETURNING returned no row");
  return service;
}

/**
 * Sets the order of all services: `ids` must list every service exactly once.
 * Returns false if it doesn't.
 */
export async function reorderServices(
  db: D1Database,
  ids: readonly string[],
  now: string,
): Promise<boolean> {
  const { results } = await db.prepare("SELECT id FROM services").all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length) return false;
  if (!ids.every((id) => existing.has(id))) return false;
  if (ids.length === 0) return true;
  await db.batch(
    ids.map((id, position) =>
      db
        .prepare("UPDATE services SET position = ?, updated_at = ? WHERE id = ?")
        .bind(position, now, id),
    ),
  );
  return true;
}

export function updateService(
  db: D1Database,
  id: string,
  input: ServiceInput,
  now: string,
): Promise<Service | null> {
  return db
    .prepare(
      `UPDATE services SET name = ?, description = ?, position = COALESCE(?, position),
         updated_at = ?
       WHERE id = ? RETURNING *`,
    )
    .bind(input.name, input.description, input.position ?? null, now, id)
    .first<Service>();
}

export async function deleteService(
  db: D1Database,
  id: string,
): Promise<"deleted" | "not_found" | "in_use"> {
  const used = await db
    .prepare("SELECT 1 FROM incident_services WHERE service_id = ? LIMIT 1")
    .bind(id)
    .first();
  if (used !== null) return "in_use";
  const { meta } = await db.prepare("DELETE FROM services WHERE id = ?").bind(id).run();
  return meta.changes > 0 ? "deleted" : "not_found";
}

/** The ids in `ids` that don't belong to any service. */
export async function unknownServiceIds(db: D1Database, ids: readonly string[]): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT id FROM services)")
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

// Incidents

export async function getIncident(db: D1Database, id: string): Promise<Incident | null> {
  const row = await db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).bind(id).first<IncidentRow>();
  return row && toIncident(row);
}

/** Incidents that are active or upcoming at `now`, soonest first. */
export async function listCurrentIncidents(db: D1Database, now: string): Promise<Incident[]> {
  const { results } = await db
    .prepare(
      `${INCIDENT_SELECT} WHERE i.ends_at IS NULL OR i.ends_at > ? ORDER BY i.starts_at, i.id`,
    )
    .bind(now)
    .all<IncidentRow>();
  return results.map(toIncident);
}

/**
 * One page of incidents, optionally only those in `state` at `now`. Upcoming incidents
 * are listed soonest first, everything else newest first.
 */
export async function listIncidents(
  db: D1Database,
  options: { state?: State | undefined; limit: number; after?: Cursor | undefined; now: string },
): Promise<{ incidents: Incident[]; next: Cursor | null }> {
  const { state, limit, after, now } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (state === "upcoming") {
    where.push("i.starts_at > ?");
    params.push(now);
  } else if (state === "active") {
    where.push("i.starts_at <= ? AND (i.ends_at IS NULL OR i.ends_at > ?)");
    params.push(now, now);
  } else if (state === "ended") {
    where.push("i.ends_at <= ?");
    params.push(now);
  }

  const ascending = state === "upcoming";
  if (after) {
    where.push(`(i.starts_at, i.id) ${ascending ? ">" : "<"} (?, ?)`);
    params.push(after.starts_at, after.id);
  }

  const order = ascending ? "ASC" : "DESC";
  const sql = `${INCIDENT_SELECT}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.starts_at ${order}, i.id ${order}
    LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...params, limit + 1)
    .all<IncidentRow>();

  const incidents = results.slice(0, limit).map(toIncident);
  const last = incidents.at(-1);
  const next = results.length > limit && last ? { starts_at: last.starts_at, id: last.id } : null;
  return { incidents, next };
}

function incidentStatements(
  db: D1Database,
  id: string,
  input: IncidentInput,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM incident_services WHERE incident_id = ?").bind(id),
    db
      .prepare(
        "INSERT INTO incident_services (incident_id, service_id) SELECT ?, value FROM json_each(?)",
      )
      .bind(id, JSON.stringify(input.service_ids)),
  ];
}

export async function createIncident(
  db: D1Database,
  input: IncidentInput,
  now: string,
): Promise<Incident> {
  const incident: Incident = {
    id: crypto.randomUUID(),
    ...input,
    updates: [],
    created_at: now,
    updated_at: now,
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO incidents (id, title, body, impact, starts_at, ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        incident.id,
        incident.title,
        incident.body,
        incident.impact,
        incident.starts_at,
        incident.ends_at,
        now,
        now,
      ),
    ...incidentStatements(db, incident.id, input),
  ]);
  return incident;
}

/** Replaces the incident's fields and affected services. D1 runs a batch as one transaction. */
export async function updateIncident(
  db: D1Database,
  id: string,
  input: IncidentInput,
  now: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE incidents SET title = ?, body = ?, impact = ?, starts_at = ?, ends_at = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.title, input.body, input.impact, input.starts_at, input.ends_at, now, id),
    ...incidentStatements(db, id, input),
  ]);
}

export async function deleteIncident(db: D1Database, id: string): Promise<boolean> {
  const [, , result] = await db.batch([
    db.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id),
    db.prepare("DELETE FROM incident_services WHERE incident_id = ?").bind(id),
    db.prepare("DELETE FROM incidents WHERE id = ?").bind(id),
  ]);
  return (result?.meta.changes ?? 0) > 0;
}

/** Adds an update and sets the incident's end time, in one transaction. */
export async function addIncidentUpdate(
  db: D1Database,
  incidentId: string,
  input: UpdateInput,
  endsAt: string | null,
  now: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO incident_updates (id, incident_id, status, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), incidentId, input.status, input.body, now),
    db
      .prepare("UPDATE incidents SET ends_at = ?, updated_at = ? WHERE id = ?")
      .bind(endsAt, now, incidentId),
  ]);
}

export async function deleteIncidentUpdate(
  db: D1Database,
  incidentId: string,
  updateId: string,
): Promise<boolean> {
  const { meta } = await db
    .prepare("DELETE FROM incident_updates WHERE id = ? AND incident_id = ?")
    .bind(updateId, incidentId)
    .run();
  return meta.changes > 0;
}
