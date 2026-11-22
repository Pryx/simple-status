import type { Child } from "hono/jsx";
import type { Incident, Service } from "../db";
import { BANNER_LABELS, type Status, stateOf } from "../status";
import { IncidentCard } from "./incident-card";
import { Layout, StatusBadge, ThemeToggle } from "./layout";

/**
 * The public site, rendered to static files (see publish.ts). The pages are served
 * from R2 without the Worker's headers, so the policy is set in a meta tag too.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface SiteInfo {
  name: string;
  /** Paths of the logo, and of a version for dark mode, under public/. */
  logo?: { light: string; dark?: string | undefined } | undefined;
  now: string;
  services: Service[];
}

export const historyPath = (month: string) => `/history/${month}`;
export const incidentPath = (id: string) => `/incidents/${id}`;

/** "2026-11" → "November 2026". */
export function monthName(month: string): string {
  const [year = 0, m = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m - 1)).toLocaleString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Page(props: { title: string; site: SiteInfo; children: Child }) {
  return (
    <Layout
      title={props.title}
      siteName={props.site.name}
      script="/static/app.js"
      head={
        <>
          <meta http-equiv="Content-Security-Policy" content={CSP} />
          <meta name="referrer" content="no-referrer" />
          <link rel="alternate" type="application/atom+xml" title="Incidents" href="/feed.atom" />
        </>
      }
    >
      {props.children}
      <footer class="footer wrap">
        <a href="/feed.atom">Atom feed</a>
      </footer>
    </Layout>
  );
}

/** Site name and theme switch: the only "chrome" on the public pages. */
function TopBar(props: { site: SiteInfo }) {
  const { name, logo } = props.site;
  return (
    <div class="topbar wrap">
      <a class="site-name" href="/">
        {logo ? (
          <>
            <img class={logo.dark ? "logo logo-light" : "logo"} src={`/${logo.light}`} alt={name} />
            {logo.dark && <img class="logo logo-dark" src={`/${logo.dark}`} alt={name} />}
          </>
        ) : (
          name
        )}
      </a>
      <ThemeToggle />
    </div>
  );
}

const byId = (services: Service[]) => new Map(services.map((s) => [s.id, s]));

/**
 * Past incidents, one month at a time. "Load more" links to the next older month;
 * app.js turns it into infinite scroll.
 */
function Timeline(props: {
  site: SiteInfo;
  month: string | null;
  incidents: Incident[];
  older: string | null;
}) {
  const services = byId(props.site.services);
  return (
    <section class="timeline wrap">
      <h2>Past incidents</h2>
      {props.month === null ? (
        <p class="empty">No past incidents.</p>
      ) : (
        <ol class="timeline-items">
          <li class="timeline-month">
            <h3>{monthName(props.month)}</h3>
          </li>
          {props.incidents.map((i) => (
            <li class={`status-${i.impact}`}>
              <IncidentCard
                incident={i}
                services={services}
                now={props.site.now}
                href={incidentPath(i.id)}
              />
            </li>
          ))}
        </ol>
      )}
      {props.older && (
        <a class="button load-more" href={historyPath(props.older)} data-load-more>
          Load more
        </a>
      )}
    </section>
  );
}

export function HomePage(props: {
  site: SiteInfo;
  overall: Status;
  statuses: Map<string, Status>;
  current: Incident[];
  month: string | null;
  past: Incident[];
  older: string | null;
}) {
  const { site } = props;
  const services = byId(site.services);
  const active = props.current.filter((i) => stateOf(i, site.now) === "active");
  const upcoming = props.current.filter((i) => stateOf(i, site.now) === "upcoming");
  const cards = (incidents: Incident[]) =>
    incidents.map((i) => (
      <IncidentCard incident={i} services={services} now={site.now} href={incidentPath(i.id)} />
    ));

  return (
    <Page title={site.name} site={site}>
      {/* app.js refreshes the [data-live] parts every 60 s. */}
      <header class={`hero status-${props.overall}`} data-live-class="hero">
        <TopBar site={site} />
        <h1 class="wrap" data-live="banner" aria-live="polite">
          {BANNER_LABELS[props.overall]}
        </h1>
      </header>
      <main class="wrap" data-live="main">
        <ul class="card services">
          {site.services.length === 0 && <li class="empty">No services yet.</li>}
          {site.services.map((s) => {
            const status = props.statuses.get(s.id) ?? "operational";
            return (
              <li>
                <span>
                  <strong>{s.name}</strong>
                  {s.description && <small>{s.description}</small>}
                </span>
                <StatusBadge status={status} live={status !== "operational"} />
              </li>
            );
          })}
        </ul>

        {active.length > 0 && (
          <section>
            <h2>Current incidents</h2>
            {cards(active)}
          </section>
        )}

        {upcoming.length > 0 && (
          <section>
            <h2>Scheduled</h2>
            {cards(upcoming)}
          </section>
        )}
      </main>

      <Timeline site={site} month={props.month} incidents={props.past} older={props.older} />
    </Page>
  );
}

export function MonthPage(props: {
  site: SiteInfo;
  month: string;
  incidents: Incident[];
  older: string | null;
}) {
  return (
    <Page title={`Past incidents, ${monthName(props.month)}`} site={props.site}>
      <TopBar site={props.site} />
      <Timeline
        site={props.site}
        month={props.month}
        incidents={props.incidents}
        older={props.older}
      />
    </Page>
  );
}

export function IncidentPage(props: { site: SiteInfo; incident: Incident }) {
  return (
    <Page title={props.incident.title} site={props.site}>
      <TopBar site={props.site} />
      <main class="wrap single">
        <IncidentCard
          incident={props.incident}
          services={byId(props.site.services)}
          now={props.site.now}
          heading="h1"
        />
        <p>
          <a href="/">← Back to the status page</a>
        </p>
      </main>
    </Page>
  );
}
