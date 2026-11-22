import { createMiddleware } from "hono/factory";
import { verifyWithJwks } from "hono/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { ProblemError } from "./problem";
import type { AppEnv } from "./types";

/**
 * Setting ACCESS_AUD to this value turns verification off, but only for requests to
 * localhost. It is meant for `.dev.vars` and `wrangler dev`.
 */
export const LOCAL_DEV_AUDIENCE = "local-dev-no-auth";

const KEY_TTL_MS = 5 * 60 * 1000;
let keyCache: { issuer: string; keys: HonoJsonWebKey[]; fetchedAt: number } | undefined;

async function accessKeys(issuer: string): Promise<HonoJsonWebKey[]> {
  const now = Date.now();
  if (keyCache?.issuer === issuer && now - keyCache.fetchedAt < KEY_TTL_MS) return keyCache.keys;
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Fetching Access keys failed: ${String(res.status)}`);
  const { keys } = await res.json<{ keys: HonoJsonWebKey[] }>();
  keyCache = { issuer, keys, fetchedAt: now };
  return keys;
}

const unauthorized = () =>
  new ProblemError({
    title: "Unauthorized",
    status: 401,
    detail: "A valid Cloudflare Access token is required.",
  });

/**
 * Verifies the Cloudflare Access JWT. Access already blocks unauthenticated requests
 * at the edge; this is the second check, so a misconfigured Access application or a
 * request that bypasses it (for example via another route) still gets nothing.
 */
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const audience = c.env.ACCESS_AUD;
  const { hostname } = new URL(c.req.url);

  if (audience === LOCAL_DEV_AUDIENCE && (hostname === "localhost" || hostname === "127.0.0.1")) {
    c.set("admin", "local developer");
    await next();
    return;
  }

  if (!teamDomain || !audience || audience === LOCAL_DEV_AUDIENCE) {
    console.error("ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set to use the admin.");
    throw new ProblemError({
      title: "Service Unavailable",
      status: 503,
      detail: "Admin is not configured.",
    });
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) throw unauthorized();

  const issuer = `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  let payload;
  try {
    payload = await verifyWithJwks(token, {
      keys: await accessKeys(issuer),
      allowedAlgorithms: ["RS256"],
      verification: { iss: issuer, aud: audience },
    });
  } catch (err) {
    console.warn("Rejected Access token:", err instanceof Error ? err.message : err);
    throw unauthorized();
  }

  const who = payload["email"] ?? payload["common_name"] ?? payload["sub"];
  c.set("admin", typeof who === "string" ? who : "unknown");
  await next();
});
