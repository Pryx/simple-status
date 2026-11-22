import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Values for the Worker's required secrets in tests. The bindings below take precedence
// over a developer's .dev.vars; setting process.env too silences the "missing secrets"
// warning in CI, where there is no .dev.vars.
const secrets = {
  ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  ACCESS_AUD: "test-audience",
};
Object.assign(process.env, secrets);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ...secrets, TEST_MIGRATIONS: await readD1Migrations("./migrations") },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
