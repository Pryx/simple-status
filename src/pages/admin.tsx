import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { decodeCursor, encodeCursor } from "../cursor";
import {
  type Activity,
  getIncident,
  type Incident,
  listActivity,
  listCurrentIncidents,
  listPastIncidents,
  listServices,
  queueProgress,
  type Service,
} from "../db";
import {
  BANNER_LABELS,
  type Impact,
  serviceStatuses,
  STATUS_LABELS,
  stateOf,
  UPDATE_STATUS_LABELS,
  UPDATE_STATUSES,
  type UpdateStatus,
  worst,
} from "../status";
import type { AppEnv } from "../types";
import { IncidentCard } from "./incident-card";
import { PUBLISH_PER_RUN } from "../publish";
import { Layout, StatusBadge, ThemeToggle, Time } from "./layout";

const API = "/admin/api/v1";
const PAST_PAGE_SIZE = 20;
/** Impact choices, in the order they are offered. */
const IMPACT_CHOICES: Impact[] = ["minor_outage", "major_outage", "maintenance"];

function AdminPage(props: {
  title: string;
  siteName: string;
  admin: string;
  section: "dashboard" | "services" | "activity";
  actions?: Child;
  children: Child;
}) {
  const current = (section: typeof props.section) =>
    props.section === section ? "page" : undefined;
  return (
    <Layout title={props.title} siteName={`${props.siteName} admin`} script="/static/admin.js">
      <header class="admin-bar">
        <div class="wrap">
          <a class="site-name" href="/admin">
            {props.siteName} <span>admin</span>
          </a>
          <nav>
            <a href="/admin" aria-current={current("dashboard")}>
              Dashboard
            </a>
            <a href="/admin/services" aria-current={current("services")}>
              Services
            </a>
            <a href="/admin/activity" aria-current={current("activity")}>
              Activity
            </a>
          </nav>
          <span class="admin-user">
            <small>{props.admin}</small>
            <a href="/">View site</a>
            <ThemeToggle />
          </span>
        </div>
      </header>
      <main class="wrap admin">
        <div class="page-head">
          <h1>{props.title}</h1>
          {props.actions}
        </div>
        {props.children}
      </main>
    </Layout>
  );
}

/** Forms are submitted as JSON by admin.js; see the data-* attributes it reads. */
function ApiForm(props: {
  action: string;
  method: "POST" | "PATCH";
  redirect: string;
  class?: string;
  children: Child;
}) {
  return (
    // method="post": should admin.js fail to load, a submit doesn't put the text in a URL.
    <form
      method="post"
      class={props.class ?? "stack"}
      data-api={props.action}
      data-method={props.method}
      data-redirect={props.redirect}
    >
      {props.children}
      <p class="error" role="alert" hidden />
    </form>
  );
}

/** A button that sends one request: DELETE, or POST with an empty object. */
function ApiButton(props: {
  action: "delete" | "post";
  api: string;
  redirect: string;
  confirm?: string;
  label?: string;
  children: Child;
}) {
  return (
    <button
      type="button"
      class={props.action === "delete" ? "danger" : undefined}
      data-action={props.action}
      data-api={props.api}
      data-redirect={props.redirect}
      data-confirm={props.confirm}
      aria-label={props.label}
    >
      {props.children}
    </button>
  );
}

/** A Markdown textarea; admin.js adds the toolbar and a Write / Preview switch. */
function MarkdownField(props: {
  name: string;
  label: string;
  value?: string | undefined;
  rows: number;
  maxlength: number;
  placeholder?: string;
}) {
  return (
    <textarea
      name={props.name}
      rows={props.rows}
      maxlength={props.maxlength}
      placeholder={props.placeholder}
      aria-label={props.label}
      data-markdown={`${API}/preview`}
    >
      {props.value}
    </textarea>
  );
}

/**
 * Post an update, like a comment: a one-line box that opens into an editor with the
 * status choices and the Post button. Posting "Ended" ends the incident (the message
 * is optional then), so there is no separate End button.
 */
function UpdateComposer(props: { incident: Incident; now: string; redirect: string }) {
  const { incident } = props;
  const latest = incident.updates[0]?.status;
  // The status most likely to come next.
  const suggested =
    latest && latest !== "ended"
      ? latest
      : latest
        ? "update"
        : incident.impact === "maintenance"
          ? "update"
          : "identified";
  const statuses = UPDATE_STATUSES.filter(
    (s) => s !== "ended" || stateOf(incident, props.now) !== "upcoming",
  );
  return (
    <ApiForm
      action={`${API}/incidents/${incident.id}/updates`}
      method="POST"
      redirect={props.redirect}
      class="composer"
    >
      <MarkdownField
        name="body"
        label="Update"
        rows={3}
        maxlength={5000}
        placeholder="Post an update…"
      />
      <div class="composer-footer">
        <fieldset class="pills">
          <legend class="visually-hidden">Status</legend>
          {statuses.map((s) => (
            <label class={`pill pill-${s}`}>
              <input type="radio" name="status" value={s} checked={s === suggested} />
              <span>{UPDATE_STATUS_LABELS[s]}</span>
            </label>
          ))}
        </fieldset>
        <small class="ended-hint">Ends the incident now. A message is optional.</small>
        <button type="submit" class="primary">
          Post
        </button>
      </div>
    </ApiForm>
  );
}

function IncidentForm(props: { incident: Incident | null; services: Service[] }) {
  const i = props.incident;
  const selected = new Set(i?.service_ids ?? []);
  const impact = i?.impact ?? "minor_outage";
  return (
    <ApiForm
      action={i ? `${API}/incidents/${i.id}` : `${API}/incidents`}
      method={i ? "PATCH" : "POST"}
      redirect={i ? `/admin/incidents/${i.id}` : "/admin"}
      class="card form-card stack"
    >
      <label>
        Title
        <input
          name="title"
          required
          maxlength={200}
          value={i?.title}
          placeholder="Slow API responses"
        />
      </label>
      <fieldset class="choices">
        <legend>Impact</legend>
        {IMPACT_CHOICES.map((value) => (
          <label class={`choice status-${value}`}>
            <input type="radio" name="impact" value={value} checked={value === impact} />
            <span>{STATUS_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset class="choices">
        <legend>Affected services</legend>
        {props.services.length === 0 && (
          <p class="empty">
            <a href="/admin/services">Add a service</a> first.
          </p>
        )}
        {props.services.map((s) => (
          <label class="choice">
            <input type="checkbox" name="service_ids" value={s.id} checked={selected.has(s.id)} />
            <span>{s.name}</span>
          </label>
        ))}
      </fieldset>
      <div class="two-columns">
        <label>
          Starts
          <input type="datetime-local" name="starts_at" data-utc={i?.starts_at} />
          <small>Your local time. Empty: now.</small>
        </label>
        {/* Only maintenance has a planned end; an outage ends with an "Ended" update. */}
        <label data-maintenance-only hidden={impact !== "maintenance"}>
          Ends
          <input
            type="datetime-local"
            name="ends_at"
            data-utc={i?.ends_at ?? undefined}
            required
            disabled={impact !== "maintenance"}
          />
          <small>When the maintenance is planned to end.</small>
        </label>
      </div>
      <label>
        Description
        <MarkdownField name="body" label="Description" rows={5} maxlength={20000} value={i?.body} />
        <small>Shown under "Started". Post later news as updates.</small>
      </label>
      <div class="actions">
        <button type="submit">{i ? "Save changes" : "Create incident"}</button>
      </div>
    </ApiForm>
  );
}

/** Makes it obvious that a card opens its edit page. */
function EditButton(props: { href: string }) {
  return (
    <a class="button small edit-button" href={props.href}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
      </svg>
      Edit
    </a>
  );
}

const byId = (services: Service[]) => new Map(services.map((s) => [s.id, s]));

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  body: "description",
  impact: "impact",
  starts_at: "start time",
  ends_at: "end time",
  service_ids: "services",
  name: "name",
  description: "description",
  position: "position",
};

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** What an entry did, as a phrase after the actor's name. */
function describe(entry: Activity, withSubject: boolean): Child {
  const { name = "", changed = [], status = "" } = entry.details;
  const fields = list(changed.map((f) => FIELD_NAMES[f] ?? f));
  const label = UPDATE_STATUS_LABELS[status as UpdateStatus] as string | undefined;
  const update = label ? `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} update` : "an update";
  // Which incident, on the Activity page: a link, unless it was deleted.
  const subject =
    entry.action === "incident.deleted" || !entry.subject_id ? (
      `“${name}”`
    ) : (
      <a href={`/admin/incidents/${entry.subject_id}`}>{name}</a>
    );
  const on = (word: string) =>
    withSubject ? (
      <>
        {" "}
        {word} {subject}
      </>
    ) : null;
  switch (entry.action) {
    case "incident.created":
      return <>created the incident{on("")}</>;
    case "incident.edited":
      return (
        <>
          edited the {fields}
          {on("of")}
        </>
      );
    case "incident.deleted":
      return <>deleted the incident “{name}”</>;
    case "update.posted":
      return (
        <>
          posted {update}
          {on("on")}
        </>
      );
    case "update.deleted":
      return (
        <>
          deleted {update}
          {on("on")}
        </>
      );
    case "service.created":
      return <>added the service “{name}”</>;
    case "service.edited":
      return (
        <>
          edited the {fields} of the service “{name}”
        </>
      );
    case "service.deleted":
      return <>deleted the service “{name}”</>;
    case "services.reordered":
      return "reordered the services";
    case "site.republished":
      return "republished the public site";
  }
}

/** Who did what and when, newest first. */
function ActivityList(props: { entries: Activity[]; withSubject: boolean }) {
  if (props.entries.length === 0) return <p class="empty">Nothing yet.</p>;
  return (
    <ol class="card rows activity">
      {props.entries.map((e) => (
        <li>
          <span class="activity-text">
            <strong>{e.actor}</strong> {describe(e, props.withSubject)}
          </span>
          <Time iso={e.at} />
        </li>
      ))}
    </ol>
  );
}

const ACTIVITY_PAGE_SIZE = 50;

/** "40 pages left, about 2 minutes". (admin.js has a copy.) */
export function publishProgress(queued: number): string {
  const minutes = Math.ceil(queued / PUBLISH_PER_RUN);
  const pages = queued === 1 ? "1 page left" : `${String(queued)} pages left`;
  return `${pages}, about ${minutes === 1 ? "a minute" : `${String(minutes)} minutes`}`;
}

/**
 * Publishing progress, shown while the public site is behind the database. admin.js
 * keeps it up to date while it's on screen.
 */
function PublishStatus(props: { queued: number; total: number }) {
  return (
    <div
      class="card publish-status"
      data-publish-status={`${API}/publish`}
      data-per-minute={PUBLISH_PER_RUN}
      hidden={props.queued === 0}
    >
      <p class="publish-head" role="status">
        <strong>Publishing the public site</strong>
        <span class="hint">{publishProgress(props.queued)}</span>
      </p>
      {/* The fill's width is set by admin.js: the CSP allows no inline styles. */}
      <div
        class="progress"
        role="progressbar"
        aria-label="Publishing progress"
        aria-valuemin={0}
        aria-valuemax={props.total || 1}
        aria-valuenow={props.total - props.queued}
      >
        <span />
      </div>
    </div>
  );
}

export const adminPages = new Hono<AppEnv>()
  .get("/", async (c) => {
    const now = new Date().toISOString();
    const [services, current, past, queued] = await Promise.all([
      listServices(c.env.DB),
      listCurrentIncidents(c.env.DB, now),
      listPastIncidents(c.env.DB, {
        limit: PAST_PAGE_SIZE,
        after: decodeCursor(c.req.query("cursor")),
        now,
      }),
      queueProgress(c.env.DB),
    ]);
    const statuses = serviceStatuses(
      services.map((s) => s.id),
      current,
      now,
    );
    const overall = worst(statuses.values());
    const serviceMap = byId(services);

    return c.html(
      <AdminPage
        title="Dashboard"
        siteName={c.env.SITE_NAME}
        admin={c.var.admin}
        section="dashboard"
        actions={
          <a class="button primary" href="/admin/incidents/new">
            New incident
          </a>
        }
      >
        <p class={`admin-banner status-${overall}`}>
          {BANNER_LABELS[overall]} <a href="/">View status page</a>
        </p>
        <PublishStatus {...queued} />

        <section>
          <h2>Ongoing and scheduled</h2>
          {current.length === 0 ? (
            <p class="card empty-state">
              Nothing is going on.{" "}
              <a href="/admin/incidents/new">Report an incident or schedule maintenance</a>.
            </p>
          ) : (
            current.map((i) => (
              <IncidentCard
                incident={i}
                services={serviceMap}
                now={now}
                href={`/admin/incidents/${i.id}`}
                headerAction={<EditButton href={`/admin/incidents/${i.id}`} />}
                showAuthors
              >
                <UpdateComposer incident={i} now={now} redirect="/admin" />
              </IncidentCard>
            ))
          )}
        </section>

        <section>
          <h2>Past incidents</h2>
          {past.incidents.length === 0 ? (
            <p class="empty">None yet.</p>
          ) : (
            <ul class="card rows">
              {past.incidents.map((i) => (
                <li class={`status-${i.impact}`}>
                  <a href={`/admin/incidents/${i.id}`}>{i.title}</a>
                  <span class="chip impact">{STATUS_LABELS[i.impact]}</span>
                  <Time iso={i.starts_at} />
                  <span class="chevron" aria-hidden="true">
                    ›
                  </span>
                </li>
              ))}
            </ul>
          )}
          {past.next && (
            <p>
              <a href={`/admin?cursor=${encodeCursor(past.next)}`}>Older incidents</a>
            </p>
          )}
        </section>

        <section>
          <h2>Public site</h2>
          <p class="hint">
            The public status page is published as static files whenever something changes. If it
            ever looks out of date, publish it again.
          </p>
          <ApiButton action="post" api={`${API}/publish`} redirect="/admin">
            Republish site
          </ApiButton>
        </section>
      </AdminPage>,
    );
  })
  .get("/incidents/new", async (c) =>
    c.html(
      <AdminPage
        title="New incident"
        siteName={c.env.SITE_NAME}
        admin={c.var.admin}
        section="dashboard"
      >
        <IncidentForm incident={null} services={await listServices(c.env.DB)} />
      </AdminPage>,
    ),
  )
  .get("/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const [incident, services, activity] = await Promise.all([
      getIncident(c.env.DB, id),
      listServices(c.env.DB),
      listActivity(c.env.DB, { subjectId: id, limit: 100 }),
    ]);
    if (!incident) return c.notFound();
    const api = `${API}/incidents/${incident.id}`;
    const self = `/admin/incidents/${incident.id}`;
    const now = new Date().toISOString();
    return c.html(
      <AdminPage
        title={incident.title}
        siteName={c.env.SITE_NAME}
        admin={c.var.admin}
        section="dashboard"
        actions={
          <a class="button" href={`/incidents/${incident.id}`}>
            View public page
          </a>
        }
      >
        <section>
          <h2>Updates</h2>
          <div class="card form-card">
            <UpdateComposer incident={incident} now={now} redirect={self} />
          </div>
          {incident.updates.length > 0 && (
            <ol class="card rows">
              {incident.updates.map((u) => (
                <li>
                  <span class="update-summary">
                    <strong>{UPDATE_STATUS_LABELS[u.status]}</strong> <Time iso={u.created_at} />
                    {u.created_by && <span class="entry-by"> · {u.created_by}</span>}
                    <span class="update-text">{u.body || "No message"}</span>
                  </span>
                  <ApiButton
                    action="delete"
                    api={`${api}/updates/${u.id}`}
                    redirect={self}
                    confirm={
                      u.status === "ended" && incident.impact !== "maintenance"
                        ? "Delete this update? The incident will be ongoing again."
                        : "Delete this update?"
                    }
                    label={`Delete the ${UPDATE_STATUS_LABELS[u.status]} update`}
                  >
                    Delete
                  </ApiButton>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h2>Details</h2>
          <IncidentForm incident={incident} services={services} />
        </section>

        <section>
          <h2>Activity</h2>
          <ActivityList entries={activity} withSubject={false} />
        </section>

        <section class="danger-zone">
          <h2>Delete</h2>
          <p>
            Removes the incident and its updates from the status page for good. To close an
            incident, post an "Ended" update instead.
          </p>
          <ApiButton action="delete" api={api} redirect="/admin" confirm="Delete this incident?">
            Delete incident
          </ApiButton>
        </section>
      </AdminPage>,
    );
  })
  .get("/activity", async (c) => {
    const before = Number(c.req.query("before")) || undefined;
    const entries = await listActivity(c.env.DB, {
      ...(before ? { before } : {}),
      limit: ACTIVITY_PAGE_SIZE + 1,
    });
    const page = entries.slice(0, ACTIVITY_PAGE_SIZE);
    const last = page.at(-1);
    return c.html(
      <AdminPage title="Activity" siteName={c.env.SITE_NAME} admin={c.var.admin} section="activity">
        <p class="hint">Every change made in the admin, newest first. Only admins see this.</p>
        <ActivityList entries={page} withSubject={true} />
        {entries.length > ACTIVITY_PAGE_SIZE && last && (
          <p>
            <a href={`/admin/activity?before=${String(last.id)}`}>Older activity</a>
          </p>
        )}
      </AdminPage>,
    );
  })
  .get("/services", async (c) => {
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
    return c.html(
      <AdminPage title="Services" siteName={c.env.SITE_NAME} admin={c.var.admin} section="services">
        <p class="hint" id="sort-hint">
          Drag a service by its handle to reorder (or focus the handle and use the arrow keys).
          Names and descriptions are saved when you leave the field.
        </p>
        {services.length > 0 && (
          <ol class="card sortable" data-sortable={`${API}/services/order`}>
            {services.map((s) => {
              const status = statuses.get(s.id) ?? "operational";
              return (
                <li data-id={s.id}>
                  <button
                    type="button"
                    class="drag-handle"
                    aria-label={`Reorder ${s.name}`}
                    aria-describedby="sort-hint"
                    title="Drag to reorder"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="9" cy="6" r="1.6" />
                      <circle cx="15" cy="6" r="1.6" />
                      <circle cx="9" cy="12" r="1.6" />
                      <circle cx="15" cy="12" r="1.6" />
                      <circle cx="9" cy="18" r="1.6" />
                      <circle cx="15" cy="18" r="1.6" />
                    </svg>
                  </button>
                  <span class="service-fields">
                    <input
                      name="name"
                      value={s.name}
                      required
                      maxlength={100}
                      aria-label={`Name of ${s.name}`}
                      data-patch={`${API}/services/${s.id}`}
                    />
                    <input
                      name="description"
                      value={s.description}
                      maxlength={500}
                      placeholder="Description (optional)"
                      aria-label={`Description of ${s.name}`}
                      data-patch={`${API}/services/${s.id}`}
                    />
                  </span>
                  <StatusBadge status={status} live={status !== "operational"} />
                  <ApiButton
                    action="delete"
                    api={`${API}/services/${s.id}`}
                    redirect="/admin/services"
                    confirm={`Delete ${s.name}?`}
                    label={`Delete ${s.name}`}
                  >
                    Delete
                  </ApiButton>
                </li>
              );
            })}
          </ol>
        )}
        <p class="save-status" data-save-status role="status" aria-live="polite" />

        <h2>Add a service</h2>
        <ApiForm
          action={`${API}/services`}
          method="POST"
          redirect="/admin/services"
          class="card form-card add-service"
        >
          <input name="name" required maxlength={100} placeholder="Name" aria-label="Name" />
          <input
            name="description"
            maxlength={500}
            placeholder="Description (optional)"
            aria-label="Description"
          />
          <button type="submit">Add service</button>
        </ApiForm>
      </AdminPage>,
    );
  });
