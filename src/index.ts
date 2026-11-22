import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { requireAccess } from "./access";
import { adminApi } from "./admin-api";
import { api } from "./api";
import { adminPages } from "./pages/admin";
import { publicPages } from "./pages/public";
import { problem, ProblemError } from "./problem";
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

// Nothing is cached: every response is rendered from D1, so it is always current.
app.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

const isApi = (path: string) =>
  path === "/api" || path.startsWith("/api/") || path.startsWith("/admin/api/");

// Everything under /admin, including unknown paths, needs Access.
app.use("/admin", requireAccess);
app.use("/admin/*", requireAccess);

app.route("/api/v1", api);
app.route("/admin/api/v1", adminApi);
app.route("/admin", adminPages);
app.route("/", publicPages);

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

export default app;
