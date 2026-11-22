import { describe, expect, it } from "vitest";
import spec from "../docs/openapi.yaml?raw";

// Keeps docs/openapi.yaml in step with the app without a YAML parser: every path the
// app serves is documented, and every $ref points at something defined.

const documented = new Set([...spec.matchAll(/^ {2}(\/[^:\s]+):$/gm)].map((m) => m[1]));

describe("OpenAPI document", () => {
  it.each([
    "/api/v1/summary",
    "/api/v1/services",
    "/api/v1/incidents/active",
    "/api/v1/incidents/scheduled",
    "/api/v1/incidents/past",
    "/api/v1/incidents/past/{month}",
    "/api/v1/incidents/{id}",
    "/feed.atom",
    "/admin/api/v1/services",
    "/admin/api/v1/services/order",
    "/admin/api/v1/services/{id}",
    "/admin/api/v1/incidents",
    "/admin/api/v1/incidents/{id}",
    "/admin/api/v1/incidents/{id}/updates",
    "/admin/api/v1/incidents/{id}/updates/{updateId}",
    "/admin/api/v1/publish",
    "/admin/api/v1/preview",
  ])("documents %s", (path) => {
    expect(documented).toContain(path);
  });

  it("uses no YAML anchors, which some renderers can't handle", () => {
    expect(spec).not.toMatch(/:\s+[&*]\w+\s*$/m);
  });

  it("defines everything it refers to", () => {
    for (const [, section, name] of spec.matchAll(/\$ref: "#\/components\/(\w+)\/(\w+)"/g)) {
      const block = spec.slice(spec.indexOf(`\n  ${section ?? ""}:\n`));
      expect(block, `${section ?? ""}/${name ?? ""}`).toMatch(new RegExp(`\\n {4}${name ?? ""}:`));
    }
  });
});
