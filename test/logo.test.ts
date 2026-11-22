import type { HtmlEscapedString } from "hono/utils/html";
import { describe, expect, it } from "vitest";
import type { Incident } from "../src/db";
import { IncidentPage, type SiteInfo } from "../src/pages/public";

const incident: Incident = {
  id: "i",
  title: "Outage",
  body: "",
  impact: "minor_outage",
  starts_at: "2026-01-01T00:00:00.000Z",
  ends_at: null,
  service_ids: [],
  updates: [],
  created_by: "admin@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const render = (site: Partial<SiteInfo>) =>
  (
    IncidentPage({
      site: { name: "Acme status", now: "2026-01-02T00:00:00.000Z", services: [], ...site },
      incident,
    }) as HtmlEscapedString
  ).toString();

describe("site name and logo", () => {
  it("shows the name without a logo", () => {
    expect(render({})).toContain('<a class="site-name" href="/">Acme status</a>');
  });

  it("shows the logo before the name", () => {
    expect(render({ logo: { light: "static/logo.svg" } })).toContain(
      '<a class="site-name" href="/"><img class="logo" src="/static/logo.svg" alt=""/>Acme status</a>',
    );
  });

  it("gives the logo its size, so the name doesn't move while it loads", () => {
    expect(render({ logo: { light: "site/logo.webp", lightSize: [250, 50] } })).toContain(
      '<img class="logo" src="/site/logo.webp" width="250" height="50" alt=""/>',
    );
  });

  it("shows the version for the theme when there is a dark one", () => {
    const html = render({ logo: { light: "static/logo.svg", dark: "static/logo-dark.svg" } });
    expect(html).toContain('<img class="logo logo-light" src="/static/logo.svg"');
    expect(html).toContain('<img class="logo logo-dark" src="/static/logo-dark.svg"');
  });
});
