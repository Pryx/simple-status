import type { Child } from "hono/jsx";
import type { Incident, Service } from "../db";
import { renderMarkdown } from "../markdown";
import { stateOf, UPDATE_STATUS_LABELS } from "../status";
import { StatusBadge, Time } from "./layout";

/** Timeline entries shown per incident in lists (plus Started); its own page shows all. */
const ENTRIES_IN_LISTS = 3;

interface Entry {
  label: string;
  iso: string;
  body?: string | undefined;
  /** Planned but not reached yet, e.g. a maintenance window's end. */
  future?: boolean;
}

/**
 * The incident's internal timeline, newest first: the (planned) end, the posted
 * updates, and Started with the description. "Ended" is shown at the incident's end
 * time, with the message of the "Ended" update if one was posted.
 */
export function entriesOf(incident: Incident, now: string): Entry[] {
  const state = stateOf(incident, now);
  const entries: Entry[] = [];
  if (incident.ends_at && state === "ended") {
    const ended = incident.updates.find((u) => u.status === "ended");
    entries.push({ label: "Ended", iso: incident.ends_at, body: ended?.body });
  } else if (incident.ends_at) {
    entries.push({ label: "Expected end", iso: incident.ends_at, future: true });
  }
  for (const u of incident.updates) {
    if (u.status === "ended") continue;
    entries.push({ label: UPDATE_STATUS_LABELS[u.status], iso: u.created_at, body: u.body });
  }
  entries.push({
    label: state === "upcoming" ? "Starts" : "Started",
    iso: incident.starts_at,
    body: incident.body,
    future: state === "upcoming",
  });
  // Stable, so on equal times the order above (end, updates, start) holds.
  return entries.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));
}

/** More services than this are shown as one "N services" chip that opens a list. */
const SERVICES_SHOWN = 2;

/**
 * The affected services: their names, or with more than two, "4 services" (or "All
 * services") that lists them on hover or tap; site.js handles the hover.
 */
function ServiceChips(props: { ids: string[]; services: Map<string, Service> }) {
  const { ids, services } = props;
  const position = (id: string) => services.get(id)?.position ?? Number.MAX_SAFE_INTEGER;
  const names = [...ids]
    .sort((a, b) => position(a) - position(b))
    .map((id) => services.get(id)?.name ?? "Deleted service");
  if (names.length <= SERVICES_SHOWN)
    return (
      <>
        {names.map((n) => (
          <span class="chip">{n}</span>
        ))}
      </>
    );
  const all = ids.length === services.size && ids.every((id) => services.has(id));
  return (
    <details class="services-more">
      <summary class="chip">{all ? "All services" : `${String(names.length)} services`}</summary>
      <ul class="services-popover">
        {names.map((n) => (
          <li>{n}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * An incident: title, impact and services, and its timeline. With `href` the title links
 * there and the timeline is shortened; without it (the incident's own page) all of it
 * is shown. `children` go below the timeline (the admin's actions).
 */
export function IncidentCard(props: {
  incident: Incident;
  services: Map<string, Service>;
  now: string;
  href?: string;
  heading?: "h1" | "h3";
  /** Shown at the end of the header, e.g. the admin's Edit button. */
  headerAction?: Child;
  children?: Child;
}) {
  const { incident, services, now, href } = props;
  const Heading = props.heading ?? "h3";
  const inList = href !== undefined;

  let entries = entriesOf(incident, now);
  // In lists, keep the newest entries and Started, and link to the rest.
  let hidden = 0;
  if (inList && entries.length > ENTRIES_IN_LISTS + 1) {
    hidden = entries.length - ENTRIES_IN_LISTS - 1;
    entries = [...entries.slice(0, ENTRIES_IN_LISTS), ...entries.slice(-1)];
  }
  const current = entries.findIndex((e) => !e.future);

  return (
    <article class={`card incident status-${incident.impact}`}>
      <header>
        <Heading>{href ? <a href={href}>{incident.title}</a> : incident.title}</Heading>
        <span class="chips">
          <StatusBadge status={incident.impact} live={stateOf(incident, now) === "active"} />
          <ServiceChips ids={incident.service_ids} services={services} />
        </span>
        {props.headerAction}
      </header>
      <ol class="entries">
        {entries.map((e, index) => (
          <>
            {hidden > 0 && index === entries.length - 1 && (
              <li class="more-entries">
                <a href={href}>
                  {hidden === 1 ? "1 more update" : `${String(hidden)} more updates`}
                </a>
              </li>
            )}
            <li
              class={["entry", e.future && "future", index === current && "current"]
                .filter(Boolean)
                .join(" ")}
            >
              <p class="entry-meta">
                <strong>{e.label}</strong> <Time iso={e.iso} />
              </p>
              {e.body && (
                <div class="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body) }} />
              )}
            </li>
          </>
        ))}
      </ol>
      {props.children && <div class="card-actions">{props.children}</div>}
    </article>
  );
}
