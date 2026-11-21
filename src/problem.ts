import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** RFC 9457 problem details. */
export interface Problem {
  type?: string;
  title: string;
  status: ContentfulStatusCode;
  detail?: string;
  instance?: string;
}

export function problem(c: Context, p: Problem): Response {
  const body = { type: "about:blank", instance: new URL(c.req.url).pathname, ...p };
  return c.body(JSON.stringify(body), p.status, {
    "Content-Type": "application/problem+json",
  });
}
