import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** An RFC 9457 problem details object. */
export interface Problem {
  type?: string;
  title: string;
  status: ContentfulStatusCode;
  detail?: string;
  instance?: string;
  /** Extension member listing validation errors. */
  errors?: { path: string; message: string }[];
}

export function problem(c: Context, p: Problem): Response {
  const body = { type: "about:blank", instance: new URL(c.req.url).pathname, ...p };
  return c.body(JSON.stringify(body), p.status, { "Content-Type": "application/problem+json" });
}

/** Thrown by handlers and turned into a problem response by the error handler. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export const notFound = () => new ProblemError({ title: "Not Found", status: 404 });

/** Parses `value` with `schema`, or throws a 422 listing every issue. */
export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProblemError({
    title: "Unprocessable Content",
    status: 422,
    detail: "The request contains invalid fields.",
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}
