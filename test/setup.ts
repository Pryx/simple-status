import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM incident_services"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM services"),
  ]);
});
