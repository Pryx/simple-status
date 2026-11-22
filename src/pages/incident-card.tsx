import type { Child } from "hono/jsx";
import type { Incident, Service } from "../db";
import { renderMarkdown } from "../markdown";
import { STATUS_LABELS, stateOf, UPDATE_STATUS_LABELS } from "../status";
import { Time } from "./layout";

/** Timeline entries shown per incident in lists (plus Started); its own page shows all. */
const ENTRIES_IN_LISTS = 3;

interface Entry {
  label: string;
  iso: string;
  body?: string;
  /** Planned but not reached yet, e.g. a maintenance window's end. */
  future?: boolean;
}

/**
 * The incident's internal timeline, newest first: Ended (or the planned end), the
 * posted updates, and Started with the description as the oldest entry.
 */
export function entriesOf(incident: Incident, now: string): Entry[] {
  const state = stateOf(incident, now);
  const entries: Entry[] = [];
  const endedUpdate = incident.updates.some((u) => u.status === "ended");
  if (incident.ends_at && state !== "ended") {
    entries.push({ label: "Expected end", iso: incident.ends_at, future: true });
  } else if (incident.ends_at && !endedUpdate) {
    entries.push({ label: "Ended", iso: incident.ends_at });
  }
  for (const u of incident.updates) {
    entries.push({ label: UPDATE_STATUS_LABELS[u.status], iso: u.created_at, body: u.body });
  }
  entries.push({
    label: state === "upcoming" ? "Starts" : "Started",
    iso: incident.starts_at,
    body: incident.body,
    future: state === "upcoming",
  });
  return entries;
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
          <span class="chip impact">{STATUS_LABELS[incident.impact]}</span>
          {incident.service_ids.map((id) => (
            <span class="chip">{services.get(id)?.name ?? "Deleted service"}</span>
          ))}
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
