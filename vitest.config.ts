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
        bindings: {
          ...secrets,
          // Fixed, whatever the site's own wrangler.jsonc says.
          SITE_NAME: "Status",
          SITE_URL: "",
          SITE_LOGO: "",
          SITE_LOGO_DARK: "",
          SITE_LOGO_SIZE: "",
          SITE_LOGO_DARK_SIZE: "",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
