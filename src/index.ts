import { Hono } from "hono";
import { html } from "hono/html";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { problem } from "./problem";

const app = new Hono<{ Bindings: Env }>();

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

const isApi = (path: string) => path === "/api" || path.startsWith("/api/");

app.get("/", (c) =>
  c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Status</title>
        </head>
        <body>
          <h1>Status</h1>
          <p>Coming soon.</p>
        </body>
      </html>`,
  ),
);

app.notFound((c) => {
  if (isApi(c.req.path)) {
    return problem(c, { title: "Not Found", status: 404 });
  }
  return c.text("Not Found", 404);
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (isApi(c.req.path)) {
      return problem(c, { title: err.message || "Error", status: err.status });
    }
    return err.getResponse();
  }
  console.error(err);
  if (isApi(c.req.path)) {
    return problem(c, { title: "Internal Server Error", status: 500 });
  }
  return c.text("Internal Server Error", 500);
});

export default app;
