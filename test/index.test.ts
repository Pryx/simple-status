import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, BASE, get, mockAccessKeys } from "./helpers";

beforeEach(mockAccessKeys);

describe("preview of the published site", () => {
  it("serves the published files with security headers", async () => {
    await admin("POST", "/publish", {});
    const res = await get("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.text()).resolves.toContain("<!doctype html>");

    const status = await get("/api/v1/summary");
    expect(status.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("needs Access like everything else", async () => {
    expect((await exports.default.fetch(`${BASE}/`)).status).toBe(401);
  });
});

describe("unknown routes", () => {
  it("returns problem+json under the admin API", async () => {
    const res = await admin("GET", "/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  it("returns 404 for unpublished paths, with a way to the admin", async () => {
    for (const path of ["/nothing-here", "/admin/nothing-here"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain('<a href="/admin">Go to the admin</a>');
    }
  });
});
