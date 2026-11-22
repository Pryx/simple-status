import { describe, expect, it } from "vitest";
import { serviceStatuses, stateOf, worst } from "../src/status";

const NOW = "2026-11-22T12:00:00.000Z";
const BEFORE = "2026-11-22T11:00:00.000Z";
const AFTER = "2026-11-22T13:00:00.000Z";

describe("stateOf", () => {
  it("is upcoming before it starts", () => {
    expect(stateOf({ starts_at: AFTER, ends_at: null }, NOW)).toBe("upcoming");
  });
  it("is active once started and until it ends", () => {
    expect(stateOf({ starts_at: BEFORE, ends_at: null }, NOW)).toBe("active");
    expect(stateOf({ starts_at: BEFORE, ends_at: AFTER }, NOW)).toBe("active");
    expect(stateOf({ starts_at: NOW, ends_at: AFTER }, NOW)).toBe("active");
  });
  it("is ended from its end time on", () => {
    expect(stateOf({ starts_at: BEFORE, ends_at: NOW }, NOW)).toBe("ended");
  });
});

describe("worst", () => {
  it("is operational for nothing", () => {
    expect(worst([])).toBe("operational");
  });
  it("orders major > minor > maintenance > operational", () => {
    expect(worst(["maintenance", "operational"])).toBe("maintenance");
    expect(worst(["maintenance", "minor_outage"])).toBe("minor_outage");
    expect(worst(["major_outage", "minor_outage", "maintenance"])).toBe("major_outage");
  });
});

describe("serviceStatuses", () => {
  const incident = (
    impact: "maintenance" | "minor_outage" | "major_outage",
    ids: string[],
    starts_at = BEFORE,
    ends_at: string | null = null,
  ) => ({
    impact,
    service_ids: ids,
    starts_at,
    ends_at,
  });

  it("uses the worst active incident per service", () => {
    const statuses = serviceStatuses(
      ["a", "b", "c"],
      [
        incident("minor_outage", ["a", "b"]),
        incident("major_outage", ["b"]),
        incident("maintenance", ["c"], BEFORE, AFTER),
      ],
      NOW,
    );
    expect(Object.fromEntries(statuses)).toEqual({
      a: "minor_outage",
      b: "major_outage",
      c: "maintenance",
    });
  });

  it("ignores upcoming and ended incidents, and unknown services", () => {
    const statuses = serviceStatuses(
      ["a"],
      [
        incident("major_outage", ["a"], AFTER),
        incident("major_outage", ["a"], BEFORE, NOW),
        incident("major_outage", ["zzz"]),
      ],
      NOW,
    );
    expect(Object.fromEntries(statuses)).toEqual({ a: "operational" });
  });
});
