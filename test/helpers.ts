import { env, exports } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { vi } from "vitest";

export const BASE = "https://status.example";
const ISSUER = "https://test.cloudflareaccess.com";

const keyPair = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const privateJwk = {
  ...((await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey),
  kid: "test-key",
};
const publicJwk = {
  ...((await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey),
  kid: "test-key",
  alg: "RS256",
};

/** Serve the test key as the Access team's public keys. */
export function mockAccessKeys() {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) {
      return Promise.resolve(Response.json({ keys: [publicJwk] }));
    }
    return realFetch(input, init);
  });
}

export function accessToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      iss: ISSUER,
      aud: ["test-audience"],
      email: "admin@example.com",
      iat: now,
      exp: now + 600,
      ...claims,
    },
    privateJwk,
    "RS256",
  );
}

/** A GET as a signed-in admin. Public paths return the published files (the preview). */
export async function get(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cf-Access-Jwt-Assertion")) {
    headers.set("Cf-Access-Jwt-Assertion", await accessToken());
  }
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers });
}

/** A published file straight from the bucket, as the public gets it. */
export async function published(key: string) {
  const object = await env.SITE.get(key);
  return object && { text: await object.text(), contentType: object.httpMetadata?.contentType };
}

export async function publishedJson<T>(key: string): Promise<T> {
  const object = await env.SITE.get(key);
  if (!object) throw new Error(`Not published: ${key}`);
  return object.json<T>();
}

/** A same-origin JSON request to the admin API with a valid Access token. */
export async function admin(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    "Cf-Access-Jwt-Assertion": await accessToken(),
    Origin: BASE,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return exports.default.fetch(`${BASE}/admin/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
}

export async function createService(name = "API") {
  const res = await admin("POST", "/services", { name });
  if (res.status !== 201)
    throw new Error(`createService: ${String(res.status)} ${await res.text()}`);
  return res.json<{ id: string; name: string }>();
}

export async function createIncident(fields: Record<string, unknown>) {
  const res = await admin("POST", "/incidents", {
    title: "Outage",
    impact: "major_outage",
    ...fields,
  });
  if (res.status !== 201)
    throw new Error(`createIncident: ${String(res.status)} ${await res.text()}`);
  return res.json<{ id: string; state: string; starts_at: string; ends_at: string | null }>();
}

export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
