#!/usr/bin/env node
// Sets up (or updates) your status page on Cloudflare in one go. You need a domain on
// Cloudflare and an API token (see README, "Deploying your own"); everything else is
// done here:
//
//  1. the D1 database and the R2 bucket;
//  2. wrangler.site.jsonc: database id, admin hostname, site name and URL;
//  3. the public hostname: connected to the bucket, CORS, and three rules (/ serves
//     index.html, pages are cached, security headers);
//  4. Cloudflare Access for the admin hostname: who may sign in;
//  5. the database tables, and the Worker, deployed with its two Access secrets.
//
// Safe to run again: it reuses what exists, and only adds or updates its own rules.
//
//   npm run setup                     # asks for what it needs
//   npm run setup -- --dry-run        # only reads, and says what it would do
//
// Options (instead of answering the questions): --domain status.example.com,
// --admin-domain admin.status.example.com, --admins a@example.com,b@example.com,
// --name "Example status", --team example (Zero Trust team, if there's none yet),
// --no-headers (skip the security headers rule).
// The token is read from CLOUDFLARE_API_TOKEN, or asked for.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseJsonc } from "./site-config.mjs";

const API = "https://api.cloudflare.com/client/v4";
const SITE_CONFIG = "wrangler.site.jsonc";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = flag("dry-run");

// Errors end the setup with their message, not a stack trace.
const fail = (err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const base = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const site = existsSync(SITE_CONFIG) ? parseJsonc(readFileSync(SITE_CONFIG, "utf8")) : {};
const databaseName = base.d1_databases.find((d) => d.binding === "DB").database_name;
const bucketName = base.r2_buckets.find((b) => b.binding === "SITE").bucket_name;

// Questions

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(question, fallback) {
  const answer = (
    await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)
  ).trim();
  return answer || fallback || "";
}
/** A question asked later on, after the first ones. */
async function askOnce(question) {
  const later = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await later.question(`${question}: `)).trim();
  } finally {
    later.close();
  }
}
const hostOf = (value) => {
  const v = value.trim();
  if (!v) return "";
  return new URL(v.includes("://") ? v : `https://${v}`).hostname;
};

const knownDomain = site.vars?.SITE_URL ? hostOf(site.vars.SITE_URL) : undefined;
const knownAdmin = site.routes?.find((r) => r.custom_domain)?.pattern;

const token = process.env.CLOUDFLARE_API_TOKEN || (await ask("Cloudflare API token"));
const domain = hostOf(
  option("domain") ??
    (await ask("Public address of the status page", knownDomain ?? "status.example.com")),
);
const adminDomain = hostOf(
  option("admin-domain") ?? (await ask("Address of the admin", knownAdmin ?? `admin.${domain}`)),
);
const siteName =
  option("name") ?? (await ask("Site name", site.vars?.SITE_NAME ?? base.vars.SITE_NAME));
const adminsAnswer =
  option("admins") ??
  (await ask("Emails of the admins, comma-separated (on a re-run, empty keeps them)"));
rl.close();
const parseEmails = (text) =>
  text
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
let admins = parseEmails(adminsAnswer);
if (!token || !domain || !adminDomain) {
  console.error("A token, a public address and an admin address are needed.");
  process.exit(1);
}
if (domain === adminDomain) {
  console.error("The admin needs its own address, e.g. admin." + domain);
  process.exit(1);
}

// Cloudflare API

class ApiError extends Error {
  constructor(message, status, codes) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

/** The token permission an API path needs, for error messages. */
function permissionFor(path) {
  const rules = {
    http_request_transform: "Zone · Transform Rules · Edit",
    http_request_cache_settings: "Zone · Cache Rules · Edit",
    http_response_headers_transform: "Zone · Transform Rules · Edit",
  };
  const phase = /rulesets\/phases\/(\w+)/.exec(path)?.[1];
  if (phase && rules[phase]) return rules[phase];
  if (path.includes("/rulesets/"))
    return "Zone · Transform Rules · Edit and Zone · Cache Rules · Edit";
  if (path.includes("/d1/")) return "Account · D1 · Edit";
  if (path.includes("/r2/")) return "Account · Workers R2 Storage · Edit";
  if (path.includes("/access/apps")) return "Account · Access: Apps and Policies · Edit";
  if (path.includes("/access/")) {
    return "Account · Access: Organizations, Identity Providers, and Groups · Edit";
  }
  if (path.startsWith("/zones")) return "Zone · Zone · Read";
  return undefined;
}

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const errors = json.errors ?? [];
    const text = errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("; ");
    const denied = res.status === 403 || errors.some((e) => e.code === 10000 || e.code === 9109);
    const needed = permissionFor(path);
    const hint = denied
      ? `\n  The token needs ${needed ?? "another permission"}. Add it (My Profile → API Tokens →` +
        ` … → Edit; the token stays the same) and run npm run setup again.`
      : "";
    throw new ApiError(
      `${method} ${path} → ${res.status} ${text}${hint}`,
      res.status,
      errors.map((e) => e.code),
    );
  }
  return json.result;
}

const step = (message) => console.log(`${dryRun ? "[dry run] " : ""}${message}`);
const write = async (fn) => (dryRun ? undefined : fn());

/** The zone a hostname belongs to: status.example.com → example.com. */
async function findZone(name) {
  const labels = name.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const [zone] = await cf("GET", `/zones?name=${encodeURIComponent(labels.slice(i).join("."))}`);
    if (zone) return zone;
  }
  throw new Error(`No zone for ${name} that this token can see. Is the domain on Cloudflare?`);
}

// 0. Token, zones, account

try {
  await cf("GET", "/user/tokens/verify");
} catch {
  throw new Error(
    "Cloudflare doesn't accept that API token. Copy it again from My Profile → API Tokens.",
  );
}
const zone = await findZone(domain);
await findZone(adminDomain); // The admin address must be on Cloudflare too.
const account = zone.account.id;
step(`Account ${zone.account.name ?? account}; public ${domain}, admin ${adminDomain}`);

// 1. Database and bucket

const databases = await cf(
  "GET",
  `/accounts/${account}/d1/database?name=${encodeURIComponent(databaseName)}`,
);
let databaseId = databases.find((d) => d.name === databaseName)?.uuid;
if (databaseId) {
  step(`Database ${databaseName}: exists.`);
} else {
  step(`Database ${databaseName}: creating it.`);
  databaseId = (
    await write(() => cf("POST", `/accounts/${account}/d1/database`, { name: databaseName }))
  )?.uuid;
}

const bucketPath = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucketName)}`;
let bucketExists = true;
try {
  await cf("GET", bucketPath);
} catch (err) {
  if (!(err instanceof ApiError && err.status === 404)) throw err;
  bucketExists = false;
}
step(`Bucket ${bucketName}: ${bucketExists ? "exists" : "creating it"}.`);
if (!bucketExists)
  await write(() => cf("POST", `/accounts/${account}/r2/buckets`, { name: bucketName }));

// 2. wrangler.site.jsonc

const newSite = {
  ...site,
  d1_databases: [{ binding: "DB", database_id: databaseId ?? "(created on a real run)" }],
  routes: [{ pattern: adminDomain, custom_domain: true }],
  vars: { ...site.vars, SITE_NAME: siteName, SITE_URL: `https://${domain}` },
};
step(`${SITE_CONFIG}: database id, admin address, SITE_NAME and SITE_URL.`);
await write(() =>
  writeFileSync(
    SITE_CONFIG,
    `// Your site's settings, merged over wrangler.jsonc (see README). Not in the
// repository. Written by npm run setup; you can edit it (comments aren't kept).
${JSON.stringify(newSite, null, 2)}\n`,
  ),
);

// 3. Public hostname: custom domain, CORS, rules

const { domains = [] } = await cf("GET", `${bucketPath}/domains/custom`).catch((err) => {
  if (!bucketExists && err instanceof ApiError) return {};
  throw err;
});
if (domains.find((d) => d.domain === domain)?.enabled) {
  step(`Public address: ${domain} is connected to the bucket.`);
} else {
  step(`Public address: connecting ${domain} to the bucket.`);
  await write(() =>
    cf("POST", `${bucketPath}/domains/custom`, {
      domain,
      zoneId: zone.id,
      enabled: true,
      minTLS: "1.2",
    }),
  );
}

step("CORS: the JSON API and feed can be read from any site.");
await write(() =>
  cf("PUT", `${bucketPath}/cors`, JSON.parse(readFileSync("r2-cors.json", "utf8"))),
);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const host = `http.host eq "${domain}"`;
const RULES = [
  {
    phase: "http_request_transform",
    name: "Rule: / serves index.html",
    rule: {
      ref: "simple_status_index",
      description: "simple-status: / serves index.html",
      expression: `(${host} and http.request.uri.path eq "/")`,
      action: "rewrite",
      action_parameters: { uri: { path: { value: "/index.html" } } },
    },
  },
  {
    phase: "http_request_cache_settings",
    name: "Rule: cache pages",
    rule: {
      ref: "simple_status_cache",
      description: "simple-status: cache pages as their Cache-Control says",
      expression: `(${host})`,
      action: "set_cache_settings",
      action_parameters: {
        cache: true,
        // Errors aren't cached: a page asked for before it was published must not
        // stay "Not Found" once it is.
        edge_ttl: {
          mode: "respect_origin",
          status_code_ttl: [{ status_code_range: { from: 400, to: 599 }, value: -1 }],
        },
        browser_ttl: { mode: "respect_origin" },
      },
    },
  },
];
if (!flag("no-headers")) {
  const headers = {
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP,
  };
  RULES.push({
    phase: "http_response_headers_transform",
    name: "Rule: security headers",
    rule: {
      ref: "simple_status_headers",
      description: "simple-status: security headers",
      expression: `(${host})`,
      action: "rewrite",
      action_parameters: {
        headers: Object.fromEntries(
          Object.entries(headers).map(([n, value]) => [n, { operation: "set", value }]),
        ),
      },
    },
  });
}

for (const { phase, name, rule } of RULES) {
  const entrypoint = `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`;
  let ruleset;
  try {
    ruleset = await cf("GET", entrypoint);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  const existing = ruleset?.rules?.find((r) => r.ref === rule.ref);
  if (!ruleset) {
    step(`${name}: adding it.`);
    await write(() => cf("PUT", entrypoint, { rules: [rule] }));
  } else if (existing) {
    step(`${name}: updating it.`);
    await write(() =>
      cf("PATCH", `/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`, rule),
    );
  } else {
    step(`${name}: adding it (the zone's other rules stay as they are).`);
    await write(() => cf("POST", `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, rule));
  }
}

// 4. Access for the admin

const ZERO_TRUST_STEPS = `
Set up Zero Trust once in the dashboard, then run npm run setup again:
  1. Go to https://one.dash.cloudflare.com/ (or "Zero Trust" in the dashboard's sidebar)
     and pick this account.
  2. Choose a team name: it becomes <team>.cloudflareaccess.com, the sign-in page.
  3. Choose the Free plan (up to 50 users). It may ask for a payment method; the Free
     plan costs nothing.`;

let organization;
try {
  organization = await cf("GET", `/accounts/${account}/access/organizations`);
} catch (err) {
  if (!(err instanceof ApiError && (err.status === 404 || err.status === 400))) throw err;
}
if (!organization?.auth_domain) {
  // No Zero Trust team yet: try to create one; it needs the Free plan chosen first.
  const team = (
    option("team") ?? (await askOnce("Zero Trust team name (for <team>.cloudflareaccess.com)"))
  )
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!team) {
    console.error(ZERO_TRUST_STEPS);
    process.exit(1);
  }
  step(`Zero Trust: creating the team ${team}.cloudflareaccess.com.`);
  try {
    organization = (await write(() =>
      cf("POST", `/accounts/${account}/access/organizations`, {
        name: team,
        auth_domain: `${team}.cloudflareaccess.com`,
      }),
    )) ?? { auth_domain: `${team}.cloudflareaccess.com` };
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n${ZERO_TRUST_STEPS}`);
    process.exit(1);
  }
}
const teamDomain = organization.auth_domain;
step(`Zero Trust: sign-in page ${teamDomain}.`);

// Admins need a way to sign in. A team without any login method gets one-time codes by
// email; an existing team's methods (Google, Okta, codes…) are left as they are, since
// other applications may rely on them.
const providers = await cf("GET", `/accounts/${account}/access/identity_providers`);
if (providers.length > 0) {
  const methods = providers.map((p) => p.name || p.type).filter(Boolean);
  step(
    `Sign-in: using the team's login methods${methods.length ? ` (${methods.join(", ")})` : ""}.`,
  );
} else {
  step("Sign-in: the team has no login method; turning on one-time codes by email.");
  await write(() =>
    cf("POST", `/accounts/${account}/access/identity_providers`, {
      name: "One-time PIN",
      type: "onetimepin",
      config: {},
    }),
  );
}

// Who may sign in is a reusable Access policy ("simple-status admins"), attached to the
// admin's application. (Earlier versions of this setup made it part of the application,
// which Cloudflare now shows as "legacy"; it's replaced here.)
const POLICY_NAME = "simple-status admins";
const apps = await cf("GET", `/accounts/${account}/access/apps`);
let app = apps.find(
  (a) => a.domain === adminDomain || a.self_hosted_domains?.includes(adminDomain),
);
const reusable = (await cf("GET", `/accounts/${account}/access/policies`)) ?? [];
let policy = reusable.find((p) => p.name === POLICY_NAME);
const legacy = (app?.policies ?? []).find(
  (p) => p.name === POLICY_NAME && p.id !== policy?.id && p.reusable !== true,
);

// A new application needs its admins: ask again if they were left empty.
if (!app && !policy && admins.length === 0) {
  admins = parseEmails(await askOnce("Emails of the admins who may sign in, comma-separated"));
}
// Who's in: the emails given, or else whoever the legacy policy let in.
const include = admins.length > 0 ? admins.map((email) => ({ email: { email } })) : legacy?.include;

if (policy && admins.length > 0) {
  step(`Access: setting who may sign in: ${admins.join(", ")}.`);
  await write(() =>
    cf("PUT", `/accounts/${account}/access/policies/${policy.id}`, {
      name: POLICY_NAME,
      decision: "allow",
      include,
    }),
  );
} else if (!policy && include?.length) {
  step(
    `Access: creating the policy "${POLICY_NAME}"` +
      (admins.length ? ` for ${admins.join(", ")}.` : ", with the admins of the legacy one."),
  );
  policy = (await write(() =>
    cf("POST", `/accounts/${account}/access/policies`, {
      name: POLICY_NAME,
      decision: "allow",
      include,
    }),
  )) ?? { id: "(new policy)" };
} else if (!policy) {
  console.error("\nTo set up who may sign in, name the admins: --admins a@example.com");
  process.exit(1);
} else {
  step(`Access: the policy "${POLICY_NAME}" exists; its admins stay.`);
}

if (!app) {
  step(`Access: creating the application for ${adminDomain}.`);
  app = await write(() =>
    cf("POST", `/accounts/${account}/access/apps`, {
      name: `${siteName} admin`,
      domain: adminDomain,
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [{ id: policy.id, precedence: 1 }],
    }),
  );
} else if (!(app.policies ?? []).some((p) => p.id === policy.id)) {
  step(
    `Access: attaching the policy to the application` +
      (legacy ? ", in place of the legacy one." : "."),
  );
  // Its other policies stay, after ours.
  const others = (app.policies ?? [])
    .filter((p) => p.id !== legacy?.id)
    .map((p, i) => ({ id: p.id, precedence: i + 2 }));
  await write(() =>
    cf("PUT", `/accounts/${account}/access/apps/${app.id}`, {
      name: app.name,
      domain: app.domain,
      type: app.type,
      session_duration: app.session_duration,
      app_launcher_visible: app.app_launcher_visible,
      policies: [{ id: policy.id, precedence: 1 }, ...others],
    }),
  );
  if (legacy) {
    await write(() =>
      cf("DELETE", `/accounts/${account}/access/apps/${app.id}/policies/${legacy.id}`).catch(
        () => undefined, // Gone with the update already.
      ),
    );
  }
} else {
  step(`Access: the application for ${adminDomain} uses the policy.`);
}

// 5. Tables and Worker

const env = { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account };
const run = (command) => {
  step(`$ ${command.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
  if (result.status !== 0) {
    // Thrown, not process.exit(), so the secrets file below is still removed.
    throw new Error(
      `${command.slice(0, 3).join(" ")} failed. Fix what it says, then run npm run setup again.`,
    );
  }
};

run(["node", "scripts/site-config.mjs"]);
run(["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.site.json"]);

// The Access secrets go up with the deploy: a new Worker can't have secrets before.
if (!dryRun && (!teamDomain || !app?.aud)) {
  throw new Error("Couldn't read the Access team or application, so the secrets can't be set.");
}
const secretsDir = mkdtempSync(join(tmpdir(), "simple-status-"));
const secretsFile = join(secretsDir, "secrets.json");
try {
  if (!dryRun) {
    writeFileSync(
      secretsFile,
      JSON.stringify({ ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: app.aud }),
      {
        mode: 0o600,
      },
    );
  }
  run(["npx", "wrangler", "deploy", "-c", "wrangler.site.json", "--secrets-file", secretsFile]);
} finally {
  rmSync(secretsDir, { recursive: true, force: true });
}

console.log(
  dryRun
    ? "\nNothing changed. Run without --dry-run to set it up."
    : `
Done.
  Status page: https://${domain}/  (published within a minute or two; certificates for
               new addresses can take a few minutes)
  Admin:       https://${adminDomain}/admin  (sign in as ${admins.length ? admins.join(" or ") : "an admin"})
From now on, npm run deploy deploys changes.`,
);
