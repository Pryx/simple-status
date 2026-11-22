import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { requireAccess } from "./access";
import { adminApi } from "./admin-api";
import { adminPages } from "./pages/admin";
import { problem, ProblemError } from "./problem";
import { isLocalhost } from "./local";
import { scheduledPublish, siteKey } from "./publish";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: "max-age=63072000; includeSubDomains",
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
  }),
);

// Admin responses are never cached.
app.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

const isApi = (path: string) => path.startsWith("/admin/api/");

// The Worker only serves admins: every path needs Access, including the preview below.
app.use(requireAccess);

app.route("/admin/api/v1", adminApi);
app.route("/admin", adminPages);

/**
 * A preview of the published site, read from the bucket. The public serves the same
 * files from the bucket's own hostname, without the Worker. In local development
 * there is no cron job, so the preview runs its work first.
 */
app.get("*", async (c) => {
  if (isLocalhost(c.req.url)) await scheduledPublish(c.env);
  const object = await c.env.SITE.get(siteKey(c.req.path));
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});

app.notFound((c) => {
  if (isApi(c.req.path)) return problem(c, { title: "Not Found", status: 404 });
  return c.text("Not Found", 404);
});

app.onError((err, c) => {
  if (err instanceof ProblemError) {
    if (isApi(c.req.path)) return problem(c, err.problem);
    return c.text(err.problem.detail ?? err.problem.title, err.problem.status);
  }
  if (err instanceof HTTPException) {
    if (isApi(c.req.path)) return problem(c, { title: err.message || "Error", status: err.status });
    return err.getResponse();
  }
  console.error(err);
  if (isApi(c.req.path)) return problem(c, { title: "Internal Server Error", status: 500 });
  return c.text("Internal Server Error", 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await scheduledPublish(env);
  },
} satisfies ExportedHandler<Env>;
