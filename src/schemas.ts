import { z } from "zod";
import { IMPACTS, STATES, UPDATE_STATUSES } from "./status";

/** Any ISO 8601 date-time with an offset, normalised to UTC with milliseconds. */
const timestamp = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());

export const serviceInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  /** Defaults to after the last service. */
  position: z.int().min(0).max(1_000_000).optional(),
});
export type ServiceInput = z.output<typeof serviceInput>;

/** How far ahead an outage's end may be and still count as "now". */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const incidentInput = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000).default(""),
    impact: z.enum(IMPACTS),
    starts_at: timestamp.optional(),
    ends_at: timestamp.nullable().default(null),
    service_ids: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)].sort()),
  })
  .transform(({ starts_at, ends_at, ...rest }) => {
    const now = new Date().toISOString();
    // Only maintenance has a planned end; an outage ends when someone ends it. An end a
    // few minutes ahead is clock skew ("End now" sends the browser's time): use now.
    const skewLimit = new Date(Date.now() + MAX_CLOCK_SKEW_MS).toISOString();
    const outageEndingNow =
      rest.impact !== "maintenance" && ends_at !== null && ends_at > now && ends_at <= skewLimit;
    return {
      ...rest,
      starts_at: starts_at ?? now,
      ends_at: outageEndingNow ? now : ends_at,
    };
  })
  .superRefine((value, ctx) => {
    if (value.impact !== "maintenance" && value.ends_at !== null) {
      if (value.ends_at > new Date().toISOString()) {
        ctx.addIssue({
          code: "custom",
          path: ["ends_at"],
          message: "Only maintenance can end in the future. End an outage once it is over.",
        });
      }
    }
    if (value.ends_at !== null && value.ends_at <= value.starts_at) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Must be after starts_at" });
    }
    if (value.impact === "maintenance" && value.ends_at === null) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Maintenance needs an end time" });
    }
  });
export type IncidentInput = z.output<typeof incidentInput>;

export const updateInput = z.strictObject({
  status: z.enum(UPDATE_STATUSES),
  body: z.string().trim().min(1).max(5_000),
});
export type UpdateInput = z.output<typeof updateInput>;

export const serviceOrder = z.strictObject({
  ids: z.array(z.string().min(1).max(64)).max(1_000),
});

export const MAX_LIMIT = 50;

export const listQuery = z.object({
  state: z.enum(STATES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((n) => Math.min(n, MAX_LIMIT)),
  cursor: z.string().max(200).optional(),
});
