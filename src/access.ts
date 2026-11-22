import { createMiddleware } from "hono/factory";
import { verifyWithJwks } from "hono/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { isLocalhost } from "./local";
import { ProblemError } from "./problem";
import type { AppEnv } from "./types";

/**
 * Setting ACCESS_AUD to this value turns verification off, but only for requests to
 * localhost. It is meant for `.dev.vars` and `wrangler dev`.
 */
export const LOCAL_DEV_AUDIENCE = "local-dev-no-auth";

const KEY_TTL_MS = 5 * 60 * 1000;
/** After a failed fetch, or a fetch made for an unknown key, wait this long before the next. */
const REFETCH_AFTER_MS = 30 * 1000;

interface KeySet {
  issuer: string;
  keys: HonoJsonWebKey[];
  fetchedAt: number;
}
let cached: KeySet | undefined;
/** Shared by concurrent requests, so a cold isolate fetches the keys once. */
let pending: Promise<KeySet> | undefined;
let failedAt = 0;

/**
 * The Access team's signing keys, cached. A token signed with a key we don't know
 * (Access rotated its keys) triggers one early refetch, at most every 30 seconds.
 */
async function accessKeys(issuer: string, kid: string): Promise<HonoJsonWebKey[]> {
  const now = Date.now();
  const fresh = cached?.issuer === issuer && now - cached.fetchedAt < KEY_TTL_MS;
  const known = cached?.keys.some((k) => k.kid === kid) ?? false;
  if (cached && fresh && (known || now - cached.fetchedAt < REFETCH_AFTER_MS)) return cached.keys;
  // While Access is unreachable, keep using the keys we have.
  const fallback = () => {
    if (cached?.issuer === issuer) return cached.keys;
    throw new Error("Access keys unavailable");
  };
  if (now - failedAt < REFETCH_AFTER_MS) return fallback();

  pending ??= (async () => {
    try {
      const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`Fetching Access keys failed: ${String(res.status)}`);
      const { keys } = await res.json<{ keys: HonoJsonWebKey[] }>();
      cached = { issuer, keys, fetchedAt: Date.now() };
      return cached;
    } catch (err) {
      failedAt = Date.now();
      throw err;
    } finally {
      pending = undefined;
    }
  })();
  try {
    return (await pending).keys;
  } catch {
    return fallback();
  }
}

/** The key id from a JWT's header, or null if it isn't a well-formed RS256 JWT. */
function keyIdOf(token: string): string | null {
  try {
    const [header] = token.split(".");
    const decoded = JSON.parse(atob((header ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as {
      alg?: unknown;
      kid?: unknown;
    };
    return decoded.alg === "RS256" && typeof decoded.kid === "string" ? decoded.kid : null;
  } catch {
    return null;
  }
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
  if (audience === LOCAL_DEV_AUDIENCE && isLocalhost(c.req.url)) {
    c.set("admin", "local developer");
    await next();
    return;
  }

  if (!teamDomain || !audience || audience === LOCAL_DEV_AUDIENCE) {
    console.error(
      isLocalhost(c.req.url)
        ? "ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set. Locally: cp .dev.vars.example .dev.vars, then restart."
        : "ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set to use the admin. Run npm run setup.",
    );
    throw new ProblemError({
      title: "Service Unavailable",
      status: 503,
      detail: "Admin is not configured.",
    });
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  // Decode the header before fetching anything, so junk doesn't cost a key fetch.
  const kid = token ? keyIdOf(token) : null;
  if (!token || !kid) throw unauthorized();

  const issuer = `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  let payload;
  try {
    payload = await verifyWithJwks(token, {
      keys: await accessKeys(issuer, kid),
      allowedAlgorithms: ["RS256"],
      verification: { iss: issuer, aud: audience },
    });
  } catch (err) {
    // Only the error's name: some messages include the token itself.
    console.warn("Rejected Access token:", err instanceof Error ? err.name : "unknown error");
    throw unauthorized();
  }

  const who = payload["email"] ?? payload["common_name"] ?? payload["sub"];
  c.set("admin", typeof who === "string" ? who : "unknown");
  await next();
});
