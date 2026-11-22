import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { decodeCursor, encodeCursor } from "../cursor";
import {
  getIncident,
  type Incident,
  listCurrentIncidents,
  listIncidents,
  listServices,
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
import { Layout, ThemeToggle, Time } from "./layout";

const API = "/admin/api/v1";
const PAST_PAGE_SIZE = 20;
/** Impact choices, in the order they are offered. */
const IMPACT_CHOICES: Impact[] = ["minor_outage", "major_outage", "maintenance"];

function AdminPage(props: {
  title: string;
  siteName: string;
  admin: string;
  section: "dashboard" | "services";
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
    <form
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

function ApiButton(props: {
  action: "delete" | "resolve";
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

/** The status most likely to come next, preselected in the update form. */
function suggestedStatus(incident: Incident): UpdateStatus {
  const latest = incident.updates[0]?.status;
  if (latest) return latest;
  return incident.impact === "maintenance" ? "update" : "identified";
}

/** Post an update (and optionally move the end), or end the incident now. */
function UpdateForm(props: { incident: Incident; now: string; redirect: string }) {
  const { incident } = props;
  const api = `${API}/incidents/${incident.id}`;
  const suggested = suggestedStatus(incident);
  return (
    <ApiForm action={`${api}/updates`} method="POST" redirect={props.redirect} class="update-form">
      <div class="update-row">
        <select name="status" aria-label="Status">
          {UPDATE_STATUSES.map((s) => (
            <option value={s} selected={s === suggested}>
              {UPDATE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <textarea
          name="body"
          rows={2}
          required
          maxlength={5000}
          placeholder="What's happening? (Markdown)"
          aria-label="Message"
        />
      </div>
      <div class="actions">
        <button type="submit">Post update</button>
        {stateOf(incident, props.now) === "active" && (
          <ApiButton action="resolve" api={api} redirect={props.redirect}>
            End now
          </ApiButton>
        )}
        <small class="hint">"Ended" also ends the incident.</small>
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
        {/* Only maintenance has a planned end; outages end with "End now" or an update. */}
        <label data-maintenance-only hidden={impact !== "maintenance"}>
          Ends
          <input
            type="datetime-local"
            name="ends_at"
            data-utc={i?.ends_at ?? undefined}
            data-nullable
            required
            disabled={impact !== "maintenance"}
          />
          <small>When the maintenance is planned to end.</small>
        </label>
      </div>
      <label>
        Description (Markdown)
        <textarea name="body" rows={5} maxlength={20000}>
          {i?.body}
        </textarea>
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

export const adminPages = new Hono<AppEnv>()
  .get("/", async (c) => {
    const now = new Date().toISOString();
    const [services, current, past] = await Promise.all([
      listServices(c.env.DB),
      listCurrentIncidents(c.env.DB, now),
      listIncidents(c.env.DB, {
        state: "ended",
        limit: PAST_PAGE_SIZE,
        after: decodeCursor(c.req.query("cursor")),
        now,
      }),
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
              >
                <UpdateForm incident={i} now={now} redirect="/admin" />
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
    const [incident, services] = await Promise.all([
      getIncident(c.env.DB, c.req.param("id")),
      listServices(c.env.DB),
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
            <UpdateForm incident={incident} now={now} redirect={self} />
          </div>
          {incident.updates.length > 0 && (
            <ol class="card rows">
              {incident.updates.map((u) => (
                <li>
                  <span class="update-summary">
                    <strong>{UPDATE_STATUS_LABELS[u.status]}</strong> <Time iso={u.created_at} />
                    <span class="update-text">{u.body}</span>
                  </span>
                  <ApiButton
                    action="delete"
                    api={`${api}/updates/${u.id}`}
                    redirect={self}
                    confirm="Delete this update?"
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

        <section class="danger-zone">
          <h2>Delete</h2>
          <p>
            Removes the incident and its updates from the status page for good. To close an
            incident, end it instead.
          </p>
          <ApiButton action="delete" api={api} redirect="/admin" confirm="Delete this incident?">
            Delete incident
          </ApiButton>
        </section>
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
        <p class="hint">
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
                      aria-label="Name"
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
                  <span class={`status-text status-${status}`}>{STATUS_LABELS[status]}</span>
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
