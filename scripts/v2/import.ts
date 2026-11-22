/**
 * Converts a Server Status v2 database (a mysqldump) into SQL for simple-status.
 *
 * No I/O here: scripts/import-v2.mjs reads the dump and writes the result, and the
 * tests call these functions directly. Runs on Node (type stripping) and in workerd.
 *
 * What maps how:
 * - services: names and descriptions were stored HTML-escaped and are unescaped.
 *   Groups don't exist any more; services keep v2's order (group, then name).
 * - status rows are incidents. Types: 0 major outage, 1 minor outage, 2 maintenance,
 *   3 "Operational".
 * - v2 outages had no end: one stayed in effect for a service until a newer incident
 *   that isn't maintenance was posted for that service (usually an "Operational" one).
 *   Here an outage ends once every service it affected has been superseded that way.
 *   One that never was is still ongoing, as it was on the v2 page; the report lists it.
 * - "Operational" incidents become updates on the outages they ended: "Ended" on the
 *   one it finished, "Update" where it recovered only some of the services.
 * - The author of each incident and update is kept (shown in the admin only) and goes
 *   into the activity log.
 * - Not imported: staff accounts (sign-in is Cloudflare Access now), subscribers,
 *   queued notifications, tokens and settings. The report says what was left out.
 */

export type Value = string | number | null;
export type Row = Record<string, Value>;
export type Tables = Record<string, Row[]>;

// Reading a mysqldump

const ESCAPES: Record<string, string> = {
  "0": "\0",
  b: "\b",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
};

/** Column names per table, from the dump's CREATE TABLE statements. */
function columnsOf(dump: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const match of dump.matchAll(/CREATE TABLE `(\w+)` \(([\s\S]*?)\n\)/g)) {
    const [, table = "", body = ""] = match;
    result[table] = [...body.matchAll(/^\s*`(\w+)`/gm)].map((m) => m[1] ?? "");
  }
  return result;
}

/**
 * Reads the rows of every INSERT statement in a mysqldump (with or without column
 * lists). Handles MySQL string escapes and doubled quotes.
 */
export function parseDump(dump: string): Tables {
  const columns = columnsOf(dump);
  const tables: Tables = {};
  const insert = /INSERT INTO `(\w+)`\s*(?:\(([^)]*)\)\s*)?VALUES\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = insert.exec(dump)) !== null) {
    const table = match[1] ?? "";
    const names = match[2]
      ? match[2].split(",").map((c) => c.trim().replaceAll("`", ""))
      : (columns[table] ?? []);
    if (names.length === 0) throw new Error(`No column names for table ${table}`);
    const rows = (tables[table] ??= []);

    let i = insert.lastIndex;
    let tuple: Value[] | null = null;
    while (i < dump.length) {
      const ch = dump[i] ?? "";
      if (tuple === null) {
        if (ch === "(") tuple = [];
        else if (ch === ";") break;
        i++;
        continue;
      }
      if (ch === "'") {
        let s = "";
        i++;
        for (;;) {
          const c = dump[i];
          if (c === undefined) throw new Error("Unterminated string in dump");
          if (c === "\\") {
            const next = dump[i + 1] ?? "";
            s += ESCAPES[next] ?? next;
            i += 2;
          } else if (c === "'" && dump[i + 1] === "'") {
            s += "'";
            i += 2;
          } else if (c === "'") {
            i++;
            break;
          } else {
            s += c;
            i++;
          }
        }
        tuple.push(s);
      } else if (ch === ")") {
        rows.push(Object.fromEntries(names.map((n, k) => [n, tuple?.[k] ?? null])));
        tuple = null;
        i++;
      } else if (ch === "," || /\s/.test(ch)) {
        i++;
      } else {
        const literal = /^[^,)\s]+/.exec(dump.slice(i, i + 64))?.[0] ?? "";
        tuple.push(literal.toUpperCase() === "NULL" ? null : Number(literal));
        i += literal.length;
      }
    }
    insert.lastIndex = i;
  }
  return tables;
}

// Converting

const V2_IMPACTS = ["major_outage", "minor_outage", "maintenance"] as const;
const OPERATIONAL = 3;

/** v2 stored service names, descriptions and settings HTML-escaped. */
export function unescapeHtml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Markdown with some HTML left in it: `<br>` becomes a line break, links become
 * Markdown links, and other tags are dropped (HTML isn't rendered any more).
 * Markdown autolinks like `<https://…>` stay.
 */
export function cleanText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<a\s[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_, _q: string, href: string, text: string) => `[${text.trim() || href}](${href})`,
    )
    .replace(/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/gi, "")
    .trim();
}

/** Outages longer than this are listed in the report, to check their derived end. */
const LONG_OUTAGE_HOURS = 72;

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** A stable UUID (version 8) per v2 row, so importing twice fails instead of duplicating. */
async function stableId(kind: string, id: Value): Promise<string> {
  const data = new TextEncoder().encode(`simple-status:v2:${kind}:${String(id)}`);
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
    .split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A SQL literal. Line breaks become char(10), so every statement is one line. */
function sql(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  const quoted = `'${v.replaceAll("'", "''")}'`;
  return quoted.replaceAll("\r", "").replaceAll("\n", "' || char(10) || '");
}

const insert = (table: string, row: Record<string, string | number | null>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(sql).join(", ")});`;

const num = (v: Value | undefined) => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: Value | undefined) => (v === null || v === undefined ? "" : String(v));

interface V2Incident {
  id: Value;
  type: number;
  title: string;
  text: string;
  time: number;
  endTime: number;
  author: string;
  serviceIds: string[];
}

/**
 * Incidents linked to no service (in old installs, some are) get every service that
 * existed at the time. v2 doesn't record when a service was created, but ids only grow:
 * a service existed once an incident had linked to it or to a later one. Before the
 * first linked incident, the services of that first one are used.
 */
function attachUnlinked(
  incidents: V2Incident[],
  tables: Tables,
  serviceIds: Map<Value, string>,
  report: string[],
) {
  const linked = new Map<Value, number[]>();
  for (const link of tables["services_status"] ?? []) {
    const v2Id = num(link["service_id"]);
    if (!serviceIds.has(link["service_id"] ?? null)) continue;
    linked.set(link["status_id"] ?? null, [...(linked.get(link["status_id"] ?? null) ?? []), v2Id]);
  }
  const firstLinked = incidents.find((i) => (linked.get(i.id)?.length ?? 0) > 0);
  const existing = [...serviceIds.entries()].map(([v2Id, id]) => ({ v2Id: num(v2Id), id }));

  for (const incident of incidents) {
    if (incident.serviceIds.length > 0) continue;
    let highest = 0;
    for (const other of incidents) {
      if (other.time > incident.time) break;
      for (const v2Id of linked.get(other.id) ?? []) highest = Math.max(highest, v2Id);
    }
    if (highest === 0 && firstLinked) highest = Math.max(...(linked.get(firstLinked.id) ?? [0]));
    incident.serviceIds = existing.filter((s) => s.v2Id <= highest).map((s) => s.id);
    if (incident.serviceIds.length > 0) {
      report.push(
        `Incident ${String(incident.id)} "${incident.title}" had no services; it now affects the ${String(incident.serviceIds.length)} that existed then.`,
      );
    }
  }
}

export interface ImportResult {
  sql: string;
  report: string[];
  counts: { services: number; incidents: number; updates: number };
}

/** `now` (Unix seconds) decides which maintenance and end times are still to come. */
export async function convert(tables: Tables, now: number): Promise<ImportResult> {
  const report: string[] = [];
  const out: string[] = [
    "-- Imported from Server Status v2 by scripts/import-v2.mjs. Import into an empty database.",
  ];

  // Services, in v2's order: by group name, then by name.
  const groups = new Map((tables["services_groups"] ?? []).map((g) => [g["id"], str(g["name"])]));
  const v2Services = [...(tables["services"] ?? [])].sort((a, b) => {
    const ga = groups.get(a["group_id"] ?? null) ?? "";
    const gb = groups.get(b["group_id"] ?? null) ?? "";
    return ga.localeCompare(gb) || str(a["name"]).localeCompare(str(b["name"]));
  });
  const serviceIds = new Map<Value, string>();
  const serviceNames = new Map<string, string>();
  for (const [position, s] of v2Services.entries()) {
    const id = await stableId("service", s["id"] ?? null);
    const name = unescapeHtml(str(s["name"])).slice(0, 100) || `Service ${str(s["id"])}`;
    serviceIds.set(s["id"] ?? null, id);
    serviceNames.set(id, name);
    const at = iso(now);
    out.push(
      insert("services", {
        id,
        name,
        description: unescapeHtml(str(s["description"])).slice(0, 500),
        position,
        created_at: at,
        updated_at: at,
      }),
    );
  }
  if (groups.size > 0) {
    report.push(
      `${String(groups.size)} service group(s) aren't supported; services keep v2's order (by group, then name).`,
    );
  }

  // Incidents with their services and authors.
  const users = new Map((tables["users"] ?? []).map((u) => [u["id"], str(u["username"])]));
  const links = new Map<Value, string[]>();
  for (const link of tables["services_status"] ?? []) {
    const service = serviceIds.get(link["service_id"] ?? null);
    if (!service) continue;
    const list = links.get(link["status_id"] ?? null) ?? [];
    if (!list.includes(service)) list.push(service);
    links.set(link["status_id"] ?? null, list);
  }
  const incidents: V2Incident[] = (tables["status"] ?? [])
    .map((r) => ({
      id: r["id"] ?? null,
      type: num(r["type"] ?? null),
      title: str(r["title"]).trim(),
      text: cleanText(str(r["text"])),
      time: num(r["time"] ?? null),
      endTime: num(r["end_time"] ?? null),
      author: users.get(r["user_id"] ?? null) ?? "unknown",
      serviceIds: links.get(r["id"] ?? null) ?? [],
    }))
    .sort((a, b) => a.time - b.time || num(a.id) - num(b.id));
  attachUnlinked(incidents, tables, serviceIds, report);

  const isNewer = (a: V2Incident, b: V2Incident) =>
    a.time > b.time || (a.time === b.time && num(a.id) > num(b.id));
  const nameList = (ids: string[]) => ids.map((id) => serviceNames.get(id) ?? id).join(", ");

  let imported = 0;
  let updates = 0;
  const usedOperational = new Set<Value>();
  const ongoing: string[] = [];
  const long: string[] = [];

  for (const incident of incidents) {
    if (incident.type === OPERATIONAL) continue; // Becomes updates, below.
    const impact = V2_IMPACTS[incident.type];
    if (!impact) {
      report.push(`Skipped incident ${String(incident.id)} "${incident.title}": unknown type.`);
      continue;
    }
    if (incident.serviceIds.length === 0) {
      report.push(
        `Skipped incident ${String(incident.id)} "${incident.title}": it has no services, and there were none yet.`,
      );
      continue;
    }

    const id = await stableId("incident", incident.id);
    const startsAt = iso(incident.time);
    let endsAt: string | null = null;
    const incidentUpdates: { at: number; status: string; body: string; author: string }[] = [];

    if (impact === "maintenance") {
      if (incident.endTime > incident.time) {
        endsAt = iso(incident.endTime);
      } else {
        endsAt = iso(incident.time + 60);
        report.push(
          `Maintenance ${String(incident.id)} "${incident.title}" had no valid end; it now ends a minute after it starts.`,
        );
      }
    } else if (incident.endTime > incident.time && incident.endTime <= now) {
      endsAt = iso(incident.endTime);
    } else {
      // The first newer non-maintenance incident on each service ends it there.
      const recoveries = incident.serviceIds.map((service) => ({
        service,
        by: incidents.find(
          (other) =>
            other.type !== 2 && isNewer(other, incident) && other.serviceIds.includes(service),
        ),
      }));
      const last = recoveries.reduce<V2Incident | undefined>(
        (latest, r) => (r.by && (!latest || isNewer(r.by, latest)) ? r.by : latest),
        undefined,
      );
      if (recoveries.some((r) => !r.by) || !last) {
        ongoing.push(`${String(incident.id)} "${incident.title}" (${startsAt})`);
      } else {
        endsAt = iso(Math.max(last.time, incident.time + 1));
        const hours = (last.time - incident.time) / 3600;
        if (hours > LONG_OUTAGE_HOURS) {
          long.push(
            `${String(incident.id)} "${incident.title}" (${startsAt.slice(0, 10)}, ${String(Math.round(hours / 24))} days, ended by ${String(last.id)} "${last.title}")`,
          );
        }
      }
      // "Operational" posts that recovered its services become its updates.
      const byOperational = new Map<V2Incident, string[]>();
      for (const r of recoveries) {
        if (r.by?.type !== OPERATIONAL) continue;
        byOperational.set(r.by, [...(byOperational.get(r.by) ?? []), r.service]);
      }
      for (const [op, recovered] of byOperational) {
        usedOperational.add(op.id);
        const final = op === last && endsAt !== null;
        const message = [op.title, op.text].filter(Boolean).join("\n\n");
        incidentUpdates.push({
          at: Math.max(op.time, incident.time + 1),
          status: final ? "ended" : "update",
          body: final
            ? message
            : [`${nameList(recovered)} recovered.`, message].filter(Boolean).join("\n\n"),
          author: op.author,
        });
      }
    }

    const createdAt = startsAt;
    const updatedAt = incidentUpdates.length
      ? iso(Math.max(...incidentUpdates.map((u) => u.at)))
      : createdAt;
    out.push(
      insert("incidents", {
        id,
        title: incident.title.slice(0, 200) || "Untitled",
        body: incident.text.slice(0, 20_000),
        impact,
        starts_at: startsAt,
        ends_at: endsAt,
        created_by: `${incident.author} (v2)`,
        created_at: createdAt,
        updated_at: updatedAt,
      }),
    );
    for (const service of incident.serviceIds) {
      out.push(insert("incident_services", { incident_id: id, service_id: service }));
    }
    out.push(
      insert("activity", {
        at: createdAt,
        actor: `${incident.author} (v2)`,
        action: "incident.created",
        subject_id: id,
        details: JSON.stringify({ name: incident.title }),
      }),
    );
    for (const [n, u] of incidentUpdates.entries()) {
      out.push(
        insert("incident_updates", {
          id: await stableId(`update:${String(incident.id)}`, n),
          incident_id: id,
          status: u.status,
          body: u.body.slice(0, 5_000),
          created_by: `${u.author} (v2)`,
          created_at: iso(u.at),
        }),
        insert("activity", {
          at: iso(u.at),
          actor: `${u.author} (v2)`,
          action: "update.posted",
          subject_id: id,
          details: JSON.stringify({ name: incident.title, status: u.status }),
        }),
      );
      updates++;
    }
    imported++;
  }

  const unusedOperational = incidents.filter(
    (i) => i.type === OPERATIONAL && !usedOperational.has(i.id),
  );
  if (unusedOperational.length > 0) {
    report.push(
      `${String(unusedOperational.length)} "Operational" post(s) didn't end any outage and were left out: ${unusedOperational
        .map((i) => `${String(i.id)} "${i.title}"`)
        .join(", ")}.`,
    );
  }
  if (ongoing.length > 0) {
    report.push(
      `${String(ongoing.length)} outage(s) were never followed by a newer post for all their services, so they are still ongoing (as on the v2 page). End them in the admin if they're over: ${ongoing.join(", ")}.`,
    );
  }
  if (long.length > 0) {
    report.push(
      `${String(long.length)} outage(s) lasted over ${String(LONG_OUTAGE_HOURS / 24)} days. Their end is the next post for their services; check it's right: ${long.join(", ")}.`,
    );
  }
  for (const [table, what] of [
    ["users", "staff account(s): admins sign in with Cloudflare Access now"],
    ["subscribers", "subscriber(s): subscriptions aren't supported yet"],
    ["queue_task", "queued notification(s)"],
  ] as const) {
    const n = tables[table]?.length ?? 0;
    if (n > 0) report.push(`Not imported: ${String(n)} ${what}.`);
  }
  const siteName = tables["settings"]?.find((s) => s["setting"] === "name")?.["value"];
  if (siteName) {
    report.push(
      `v2's site name was "${unescapeHtml(str(siteName))}": set SITE_NAME in wrangler.jsonc.`,
    );
  }

  // Publish everything on the next cron run.
  out.push("DELETE FROM site_state;");
  return {
    sql: `${out.join("\n")}\n`,
    report,
    counts: { services: v2Services.length, incidents: imported, updates },
  };
}
