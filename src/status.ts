/**
 * Status rules. Pure functions, no I/O.
 *
 * One vocabulary is used everywhere: an incident's `impact` is the status it gives
 * the services it affects while it is active.
 */

export const IMPACTS = ["maintenance", "minor_outage", "major_outage"] as const;
export type Impact = (typeof IMPACTS)[number];
export type Status = "operational" | Impact;

export const STATES = ["upcoming", "active", "ended"] as const;
export type State = (typeof STATES)[number];

const SEVERITY: Record<Status, number> = {
  operational: 0,
  maintenance: 1,
  minor_outage: 2,
  major_outage: 3,
};

export interface Timed {
  starts_at: string;
  ends_at: string | null;
}

/** Times are ISO 8601 UTC strings, which compare correctly as text. */
export function stateOf(incident: Timed, now: string): State {
  if (incident.starts_at > now) return "upcoming";
  if (incident.ends_at !== null && incident.ends_at <= now) return "ended";
  return "active";
}

export function worst(statuses: Iterable<Status>): Status {
  let result: Status = "operational";
  for (const s of statuses) {
    if (SEVERITY[s] > SEVERITY[result]) result = s;
  }
  return result;
}

export interface AffectingIncident extends Timed {
  impact: Impact;
  service_ids: readonly string[];
}

/** Each service's status: the worst impact among the active incidents affecting it. */
export function serviceStatuses(
  serviceIds: readonly string[],
  incidents: readonly AffectingIncident[],
  now: string,
): Map<string, Status> {
  const result = new Map<string, Status>(serviceIds.map((id) => [id, "operational"]));
  for (const incident of incidents) {
    if (stateOf(incident, now) !== "active") continue;
    for (const id of incident.service_ids) {
      const current = result.get(id);
      if (current !== undefined) result.set(id, worst([current, incident.impact]));
    }
  }
  return result;
}

/**
 * Statuses an admin can post. "Started" and "Ended" in the public timeline come from the
 * incident's own times; posting `ended` also ends the incident.
 */
export const UPDATE_STATUSES = ["identified", "monitoring", "update", "ended"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export const UPDATE_STATUS_LABELS: Record<UpdateStatus, string> = {
  identified: "Identified",
  monitoring: "Monitoring",
  update: "Update",
  ended: "Ended",
};

export const STATUS_LABELS: Record<Status, string> = {
  operational: "Operational",
  maintenance: "Maintenance",
  minor_outage: "Minor outage",
  major_outage: "Major outage",
};

export const BANNER_LABELS: Record<Status, string> = {
  operational: "All systems operational",
  maintenance: "Maintenance in progress",
  minor_outage: "Some systems are degraded",
  major_outage: "Major outage",
};
