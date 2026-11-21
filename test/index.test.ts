import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://status.example";

describe("GET /", () => {
  it("returns HTML with security headers", async () => {
    const res = await exports.default.fetch(`${BASE}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");

    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    await expect(res.text()).resolves.toContain("<!doctype html>");
  });
});

describe("unknown routes", () => {
  it("returns problem+json under /api", async () => {
    const res = await exports.default.fetch(`${BASE}/api/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      instance: "/api/does-not-exist",
    });
  });

  it("does not treat /apix as part of the API", async () => {
    const res = await exports.default.fetch(`${BASE}/apix`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });
});
