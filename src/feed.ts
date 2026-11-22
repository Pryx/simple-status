import type { Incident } from "./db";
import { renderMarkdown } from "./markdown";
import type { SiteInfo } from "./pages/public";
import { incidentPath } from "./pages/public";
import { STATUS_LABELS, stateOf, UPDATE_STATUS_LABELS } from "./status";

const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One entry's content: its state, the latest update and the description, as HTML. */
function summary(incident: Incident, now: string): string {
  const state = stateOf(incident, now);
  const parts = [`<p><strong>${escape(STATUS_LABELS[incident.impact])}</strong>, ${state}.</p>`];
  const latest = incident.updates[0];
  if (latest?.body) {
    parts.push(
      `<p><strong>${UPDATE_STATUS_LABELS[latest.status]}</strong></p>`,
      renderMarkdown(latest.body),
    );
  }
  if (incident.body) parts.push(renderMarkdown(incident.body));
  return parts.join("\n");
}

/**
 * An Atom feed of the most recently changed incidents, so people can follow the status
 * in a feed reader, Slack or Teams. Links are absolute when SITE_URL is set; otherwise
 * relative to the feed's own URL.
 */
export function feed(site: SiteInfo, incidents: Incident[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const updated = incidents[0]?.updated_at ?? site.now;
  const entries = incidents.map(
    (i) => `  <entry>
    <id>urn:uuid:${i.id}</id>
    <title>${escape(i.title)}</title>
    <link rel="alternate" type="text/html" href="${escape(base + incidentPath(i.id))}"/>
    <published>${i.created_at}</published>
    <updated>${i.updated_at}</updated>
    <content type="html">${escape(summary(i, site.now))}</content>
  </entry>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escape(base ? `${base}/feed.atom` : `tag:simple-status,2026:${encodeURIComponent(site.name)}`)}</id>
  <title>${escape(site.name)}</title>
  <link rel="alternate" type="text/html" href="${escape(`${base}/`)}"/>
  <link rel="self" type="application/atom+xml" href="${escape(`${base}/feed.atom`)}"/>
  <author><name>${escape(site.name)}</name></author>
  <updated>${updated}</updated>
${entries.join("\n")}
</feed>
`;
}
