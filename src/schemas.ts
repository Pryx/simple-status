import { z } from "zod";
import { IMPACTS, UPDATE_STATUSES } from "./status";

/** Any ISO 8601 date-time with an offset, normalised to UTC with milliseconds. */
const timestamp = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());

export const serviceInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  /** Defaults to after the last service. */
  position: z.int().min(0).max(1_000_000).optional(),
});
export type ServiceInput = z.output<typeof serviceInput>;

/**
 * An incident's fields and rules, checked against the server's clock (`now`) only:
 * a missing start means now, only maintenance may end in the future (an outage ends
 * when someone ends it), and maintenance needs a planned end.
 */
export const incidentInput = (now: string) =>
  z
    .strictObject({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(20_000).default(""),
      impact: z.enum(IMPACTS),
      starts_at: timestamp.default(now),
      ends_at: timestamp.nullable().default(null),
      service_ids: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(100)
        .transform((ids) => [...new Set(ids)].sort()),
    })
    .superRefine((value, ctx) => {
      const issue = (message: string) => {
        ctx.addIssue({ code: "custom", path: ["ends_at"], message });
      };
      if (value.ends_at === null) {
        if (value.impact === "maintenance") issue("Maintenance needs an end time");
        return;
      }
      if (value.ends_at <= value.starts_at) issue("Must be after starts_at");
      else if (value.impact !== "maintenance" && value.ends_at > now) {
        issue("Only maintenance can end in the future. End an outage once it is over.");
      }
    });
export type IncidentInput = z.output<ReturnType<typeof incidentInput>>;

/** A status update. Only "Ended" may go without a message. */
export const updateInput = z
  .strictObject({
    status: z.enum(UPDATE_STATUSES),
    body: z.string().trim().max(5_000).default(""),
  })
  .refine((u) => u.status === "ended" || u.body !== "", {
    path: ["body"],
    message: "Write what's happening",
  });
export type UpdateInput = z.output<typeof updateInput>;

export const serviceOrder = z.strictObject({
  ids: z.array(z.string().min(1).max(64)).max(1_000),
});

export const markdownPreview = z.strictObject({ body: z.string().max(20_000) });
