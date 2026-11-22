import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM services"),
    env.DB.prepare("DELETE FROM publish_queue"),
    env.DB.prepare("DELETE FROM site_state"),
  ]);
  const { objects } = await env.SITE.list();
  if (objects.length > 0) await env.SITE.delete(objects.map((o) => o.key));
});
