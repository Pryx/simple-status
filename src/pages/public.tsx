import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { decodeCursor, encodeCursor } from "../cursor";
import {
  type Cursor,
  getIncident,
  type Incident,
  listCurrentIncidents,
  listIncidents,
  listServices,
  type Service,
} from "../db";
import { BANNER_LABELS, serviceStatuses, STATUS_LABELS, stateOf, worst } from "../status";
import type { AppEnv } from "../types";
import { IncidentCard } from "./incident-card";
import { Layout, ThemeToggle } from "./layout";

const HISTORY_PAGE_SIZE = 10;

function Page(props: { title: string; siteName: string; children: Child }) {
  return (
    <Layout title={props.title} siteName={props.siteName} script="/static/app.js">
      {props.children}
      <footer class="footer wrap">
        <a href="/api/v1/status">JSON API</a>
      </footer>
    </Layout>
  );
}

/** Site name and theme switch: the only "chrome" on the public pages. */
function TopBar(props: { siteName: string }) {
  return (
    <div class="topbar wrap">
      <a class="site-name" href="/">
        {props.siteName}
      </a>
      <ThemeToggle />
    </div>
  );
}

/** Past incidents. The "Load more" link is a plain link; app.js turns it into infinite scroll. */
function Timeline(props: {
  incidents: Incident[];
  services: Map<string, Service>;
  next: Cursor | null;
  now: string;
}) {
  return (
    <section class="timeline wrap">
      <h2>Past incidents</h2>
      {props.incidents.length === 0 ? (
        <p class="empty">No past incidents.</p>
      ) : (
        <ol class="timeline-items">
          {props.incidents.map((i) => (
            <li class={`status-${i.impact}`}>
              <IncidentCard
                incident={i}
                services={props.services}
                now={props.now}
                href={`/incidents/${i.id}`}
              />
            </li>
          ))}
        </ol>
      )}
      {props.next && (
        <a
          class="button load-more"
          href={`/history?cursor=${encodeCursor(props.next)}`}
          data-load-more
        >
          Load more
        </a>
      )}
    </section>
  );
}

const byId = (services: Service[]) => new Map(services.map((s) => [s.id, s]));

export const publicPages = new Hono<AppEnv>()
  .get("/", async (c) => {
    const now = new Date().toISOString();
    const [services, current, past] = await Promise.all([
      listServices(c.env.DB),
      listCurrentIncidents(c.env.DB, now),
      listIncidents(c.env.DB, { state: "ended", limit: HISTORY_PAGE_SIZE, now }),
    ]);
    const statuses = serviceStatuses(
      services.map((s) => s.id),
      current,
      now,
    );
    const overall = worst(statuses.values());
    const serviceMap = byId(services);
    const active = current.filter((i) => stateOf(i, now) === "active");
    const upcoming = current.filter((i) => stateOf(i, now) === "upcoming");
    const siteName = c.env.SITE_NAME;

    return c.html(
      <Page title={siteName} siteName={siteName}>
        {/* Replaced every 60 s by app.js. */}
        <div data-live>
          <header class={`hero status-${overall}`}>
            <TopBar siteName={siteName} />
            <h1 class="wrap">{BANNER_LABELS[overall]}</h1>
          </header>
          <main class="wrap">
            <ul class="card services">
              {services.length === 0 && <li class="empty">No services yet.</li>}
              {services.map((s) => {
                const status = statuses.get(s.id) ?? "operational";
                return (
                  <li>
                    <span>
                      <strong>{s.name}</strong>
                      {s.description && <small>{s.description}</small>}
                    </span>
                    <span class={`status-text status-${status}`}>{STATUS_LABELS[status]}</span>
                  </li>
                );
              })}
            </ul>

            {active.length > 0 && (
              <section>
                <h2>Current incidents</h2>
                {active.map((i) => (
                  <IncidentCard
                    incident={i}
                    services={serviceMap}
                    now={now}
                    href={`/incidents/${i.id}`}
                  />
                ))}
              </section>
            )}

            {upcoming.length > 0 && (
              <section>
                <h2>Scheduled</h2>
                {upcoming.map((i) => (
                  <IncidentCard
                    incident={i}
                    services={serviceMap}
                    now={now}
                    href={`/incidents/${i.id}`}
                  />
                ))}
              </section>
            )}
          </main>
        </div>

        <Timeline incidents={past.incidents} services={serviceMap} next={past.next} now={now} />
      </Page>,
    );
  })
  .get("/history", async (c) => {
    const now = new Date().toISOString();
    const after = decodeCursor(c.req.query("cursor"));
    const [services, page] = await Promise.all([
      listServices(c.env.DB),
      listIncidents(c.env.DB, { state: "ended", limit: HISTORY_PAGE_SIZE, after, now }),
    ]);
    const siteName = c.env.SITE_NAME;
    return c.html(
      <Page title="Past incidents" siteName={siteName}>
        <TopBar siteName={siteName} />
        <Timeline incidents={page.incidents} services={byId(services)} next={page.next} now={now} />
      </Page>,
    );
  })
  .get("/incidents/:id", async (c) => {
    const [incident, services] = await Promise.all([
      getIncident(c.env.DB, c.req.param("id")),
      listServices(c.env.DB),
    ]);
    if (!incident) return c.notFound();
    const siteName = c.env.SITE_NAME;
    return c.html(
      <Page title={incident.title} siteName={siteName}>
        <TopBar siteName={siteName} />
        <main class="wrap single">
          <IncidentCard
            incident={incident}
            services={byId(services)}
            now={new Date().toISOString()}
            heading="h1"
          />
          <p>
            <a href="/">← Back to the status page</a>
          </p>
        </main>
      </Page>,
    );
  });
