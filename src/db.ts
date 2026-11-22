import type { IncidentInput, ServiceInput, UpdateInput } from "./schemas";
import type { Impact, UpdateStatus } from "./status";

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
  /** Who created it. Admin only: incidentJson leaves it out of everything published. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentUpdate {
  id: string;
  status: UpdateStatus;
  body: string;
  /** Who posted it. Admin only, like Incident.created_by. */
  created_by: string | null;
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
  SELECT i.id, i.title, i.body, i.impact, i.starts_at, i.ends_at, i.created_by, i.created_at,
    i.updated_at,
    (SELECT json_group_array(service_id) FROM incident_services WHERE incident_id = i.id)
      AS service_ids,
    (SELECT json_group_array(json_object(
        'id', id, 'status', status, 'body', body, 'created_by', created_by,
        'created_at', created_at))
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
 * Returns false if it doesn't. One statement, so it is atomic and cheap.
 */
export async function reorderServices(
  db: D1Database,
  ids: readonly string[],
  now: string,
): Promise<boolean> {
  if (new Set(ids).size !== ids.length) return false;
  const count = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM services) AS total,
         (SELECT COUNT(*) FROM services WHERE id IN (SELECT value FROM json_each(?))) AS listed`,
    )
    .bind(JSON.stringify(ids))
    .first<{ total: number; listed: number }>();
  if (count?.total !== ids.length || count.listed !== ids.length) return false;
  await db
    .prepare(
      `UPDATE services SET updated_at = ?,
         position = (SELECT key FROM json_each(?) WHERE value = services.id)`,
    )
    .bind(now, JSON.stringify(ids))
    .run();
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
  try {
    const { meta } = await db.prepare("DELETE FROM services WHERE id = ?").bind(id).run();
    return meta.changes > 0 ? "deleted" : "not_found";
  } catch (err) {
    // incident_services.service_id is ON DELETE RESTRICT.
    if (err instanceof Error && err.message.includes("FOREIGN KEY")) return "in_use";
    throw err;
  }
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

/** One page of ended incidents, newest first. */
export async function listPastIncidents(
  db: D1Database,
  options: { limit: number; after?: Cursor | undefined; now: string },
): Promise<{ incidents: Incident[]; next: Cursor | null }> {
  const { limit, after, now } = options;
  const { results } = await db
    .prepare(
      `${INCIDENT_SELECT}
       WHERE i.ends_at <= ? AND (? IS NULL OR (i.starts_at, i.id) < (?, ?))
       ORDER BY i.starts_at DESC, i.id DESC
       LIMIT ?`,
    )
    .bind(now, after?.starts_at ?? null, after?.starts_at ?? "", after?.id ?? "", limit + 1)
    .all<IncidentRow>();
  const incidents = results.slice(0, limit).map(toIncident);
  const last = incidents.at(-1);
  const next = results.length > limit && last ? { starts_at: last.starts_at, id: last.id } : null;
  return { incidents, next };
}

// The public history is split by the UTC month an incident started in ("2026-11").

export const monthOf = (iso: string) => iso.slice(0, 7);

/** The first instant of `month` and of the month after it. */
function monthBounds(month: string): [string, string] {
  const [year = 0, m = 1] = month.split("-").map(Number);
  return [new Date(Date.UTC(year, m - 1)).toISOString(), new Date(Date.UTC(year, m)).toISOString()];
}

/** The incidents that started in `month` and have ended, newest first. */
export async function listMonth(db: D1Database, month: string, now: string): Promise<Incident[]> {
  const [from, to] = monthBounds(month);
  const { results } = await db
    .prepare(
      `${INCIDENT_SELECT}
       WHERE i.starts_at >= ? AND i.starts_at < ? AND i.ends_at <= ?
       ORDER BY i.starts_at DESC, i.id DESC`,
    )
    .bind(from, to, now)
    .all<IncidentRow>();
  return results.map(toIncident);
}

/** The latest month before `month` (or overall, if null) with ended incidents. */
export async function monthBefore(
  db: D1Database,
  month: string | null,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT starts_at FROM incidents WHERE ends_at <= ? AND starts_at < ?
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .bind(now, month ? monthBounds(month)[0] : "9999")
    .first<{ starts_at: string }>();
  return row && monthOf(row.starts_at);
}

/** The earliest month after `month` with ended incidents. */
export async function monthAfter(
  db: D1Database,
  month: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT starts_at FROM incidents WHERE ends_at <= ? AND starts_at >= ?
       ORDER BY starts_at LIMIT 1`,
    )
    .bind(now, monthBounds(month)[1])
    .first<{ starts_at: string }>();
  return row && monthOf(row.starts_at);
}

/** The most recently changed incidents, for the feed. */
export async function listRecentlyUpdated(db: D1Database, limit: number): Promise<Incident[]> {
  const { results } = await db
    .prepare(`${INCIDENT_SELECT} ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`)
    .bind(limit)
    .all<IncidentRow>();
  return results.map(toIncident);
}

/** Incidents that started or ended in (from, to]: the ones whose pages went stale. */
export async function listTransitions(
  db: D1Database,
  from: string,
  to: string,
): Promise<{ id: string; starts_at: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, starts_at FROM incidents
       WHERE (starts_at > ?1 AND starts_at <= ?2) OR (ends_at > ?1 AND ends_at <= ?2)`,
    )
    .bind(from, to)
    .all<{ id: string; starts_at: string }>();
  return results;
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
  author: string,
): Promise<Incident> {
  const incident: Incident = {
    id: crypto.randomUUID(),
    ...input,
    updates: [],
    created_by: author,
    created_at: now,
    updated_at: now,
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO incidents
           (id, title, body, impact, starts_at, ends_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        incident.id,
        incident.title,
        incident.body,
        incident.impact,
        incident.starts_at,
        incident.ends_at,
        author,
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
  // Its updates and links to services go with it (ON DELETE CASCADE).
  const { meta } = await db.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
  return meta.changes > 0;
}

/**
 * Adds an update, in one transaction with setting the incident's end time when
 * `endsAt` is given (an "Ended" update). Other updates leave the end time alone.
 */
export async function addIncidentUpdate(
  db: D1Database,
  incidentId: string,
  input: UpdateInput,
  endsAt: string | undefined,
  now: string,
  author: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO incident_updates (id, incident_id, status, body, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), incidentId, input.status, input.body, author, now),
    db
      .prepare("UPDATE incidents SET ends_at = COALESCE(?, ends_at), updated_at = ? WHERE id = ?")
      .bind(endsAt ?? null, now, incidentId),
  ]);
}

/**
 * Deletes an update. Deleting an outage's only "Ended" update reopens the outage, so
 * the timeline and the status stay in step. (Maintenance keeps its end time: move it
 * on the edit page.)
 */
export async function deleteIncidentUpdate(
  db: D1Database,
  incidentId: string,
  updateId: string,
  now: string,
): Promise<boolean> {
  const [, deleted] = await db.batch([
    db
      .prepare(
        `UPDATE incidents SET ends_at = NULL WHERE id = ?1 AND impact != 'maintenance'
           AND EXISTS (SELECT 1 FROM incident_updates
                       WHERE id = ?2 AND incident_id = ?1 AND status = 'ended')
           AND (SELECT COUNT(*) FROM incident_updates
                WHERE incident_id = ?1 AND status = 'ended') = 1`,
      )
      .bind(incidentId, updateId),
    db
      .prepare("DELETE FROM incident_updates WHERE id = ? AND incident_id = ?")
      .bind(updateId, incidentId),
    db.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").bind(now, incidentId),
  ]);
  return (deleted?.meta.changes ?? 0) > 0;
}

// Publishing queue and site state

/**
 * The largest the queue has been since it was last empty: the "of" in "12 of 40
 * pages published". Raised after each enqueue, cleared once the queue is empty.
 */
const RAISE_QUEUE_PEAK = `
  INSERT INTO site_state (key, value)
  SELECT 'queue_peak', CAST(COUNT(*) AS TEXT) FROM publish_queue WHERE true
  ON CONFLICT (key) DO UPDATE SET
    value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`;

export async function enqueue(db: D1Database, keys: Iterable<string>, now: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO publish_queue (key, queued_at) SELECT value, ?1 FROM json_each(?2) WHERE true
       ON CONFLICT (key) DO UPDATE SET queued_at = excluded.queued_at`,
      )
      .bind(now, JSON.stringify([...new Set(keys)])),
    db.prepare(RAISE_QUEUE_PEAK),
  ]);
}

/** Queues every page of the site. */
export async function enqueueAll(db: D1Database, now: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO publish_queue (key, queued_at)
       SELECT 'home', ?1 UNION SELECT 'assets', ?1
       UNION SELECT 'incident:' || id, ?1 FROM incidents
       UNION SELECT DISTINCT 'month:' || substr(starts_at, 1, 7), ?1 FROM incidents WHERE true
       ON CONFLICT (key) DO UPDATE SET queued_at = excluded.queued_at`,
      )
      .bind(now),
    db.prepare(RAISE_QUEUE_PEAK),
  ]);
}

export interface QueueEntry {
  key: string;
  queued_at: string;
}

/**
 * The next `limit` entries, most needed first: the home page, the assets, then the
 * month pages ("Load more" and the API's paging follow them), then incident pages.
 */
export async function peekQueue(db: D1Database, limit: number): Promise<QueueEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT key, queued_at FROM publish_queue
       ORDER BY CASE WHEN key = 'home' THEN 0 WHEN key = 'assets' THEN 1
                     WHEN key LIKE 'month:%' THEN 2 ELSE 3 END,
                queued_at, key DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<QueueEntry>();
  return results;
}

/** Removes entries that weren't queued again while they were being published. */
export async function dequeue(db: D1Database, entries: readonly QueueEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db
    .prepare(
      `DELETE FROM publish_queue WHERE (key, queued_at) IN
         (SELECT value ->> 'key', value ->> 'queued_at' FROM json_each(?))`,
    )
    .bind(JSON.stringify(entries))
    .run();
}

export async function queueLength(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM publish_queue").first<number>("n")) ?? 0;
}

/** Pages waiting, and how many there were in all since the queue was last empty. */
export async function queueProgress(db: D1Database): Promise<{ queued: number; total: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM publish_queue) AS queued,
         (SELECT CAST(value AS INTEGER) FROM site_state WHERE key = 'queue_peak') AS peak`,
    )
    .first<{ queued: number; peak: number | null }>();
  const queued = row?.queued ?? 0;
  if (queued === 0) {
    await db.prepare("DELETE FROM site_state WHERE key = 'queue_peak'").run();
    return { queued: 0, total: 0 };
  }
  return { queued, total: Math.max(queued, row?.peak ?? 0) };
}

export function getState(db: D1Database, key: string): Promise<string | null> {
  return db.prepare("SELECT value FROM site_state WHERE key = ?").bind(key).first<string>("value");
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_state (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

// Activity log

export const ACTIONS = [
  "incident.created",
  "incident.edited",
  "incident.deleted",
  "update.posted",
  "update.deleted",
  "service.created",
  "service.edited",
  "service.deleted",
  "services.reordered",
  "site.republished",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface ActivityDetails {
  /** The incident's title or the service's name, so entries read well after deletion. */
  name?: string;
  /** Fields changed by an edit. */
  changed?: string[];
  /** An update's status. */
  status?: string;
}

export interface Activity {
  id: number;
  at: string;
  actor: string;
  action: Action;
  subject_id: string | null;
  details: ActivityDetails;
}

export async function logActivity(db: D1Database, entry: Omit<Activity, "id">): Promise<void> {
  await db
    .prepare("INSERT INTO activity (at, actor, action, subject_id, details) VALUES (?, ?, ?, ?, ?)")
    .bind(entry.at, entry.actor, entry.action, entry.subject_id, JSON.stringify(entry.details))
    .run();
}

/** Newest first: all of it, or one incident's or service's, before the entry `before`. */
export async function listActivity(
  db: D1Database,
  options: { subjectId?: string; before?: number; limit: number },
): Promise<Activity[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM activity
       WHERE (?1 IS NULL OR subject_id = ?1) AND (?2 IS NULL OR id < ?2)
       ORDER BY id DESC LIMIT ?3`,
    )
    .bind(options.subjectId ?? null, options.before ?? null, options.limit)
    .all<Omit<Activity, "details"> & { details: string }>();
  return results.map((r) => ({ ...r, details: JSON.parse(r.details) as ActivityDetails }));
}
