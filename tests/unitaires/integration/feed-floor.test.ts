import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DELIVERY_EVENT_WRITER_BOUND_MS,
  FEED_FLOOR_DEFAULT_MARGIN_MS,
  FEED_FLOOR_MIN_MARGIN_MS,
  feedFloorMarginProblem,
  feedFloorMs,
} from "@/modules/integration/feed-floor";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * The feed's floor and the bound it stands on (plano-escala U-16, D66).
 *
 * The floor of /integration/v1/events never skips an event only while two
 * numbers keep their relation: the 240 s a writer of delivery_event has
 * from its transaction's start (the triggers' argument, in SQL) and the
 * margin the feed subtracts (FEED_FLOOR_MARGIN_MS, at least twice that).
 * The SQL and the TypeScript hold the bound apart, so this reads the
 * migration back; and a margin set too low must stop the boot instead of
 * quietly letting the floor pass over a writable event.
 */
const MIGRATION = resolve(
  process.cwd(),
  "prisma/migrations/20261118100000_delivery_event_writer_bound/migration.sql",
);

const DEVELOPMENT = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string>) =>
  envSchema.safeParse(definedEnv({ ...DEVELOPMENT, ...overrides }));

describe("the writer bound", () => {
  it("is the argument both triggers are created with", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const triggers = [
      ...sql.matchAll(
        /CREATE OR REPLACE TRIGGER "(\w+)"\s+BEFORE INSERT ON "(\w+)"\s+FOR EACH STATEMENT\s+EXECUTE FUNCTION "trajetto_delivery_event_writer_bound"\('(\d+)'\)/g,
      ),
    ].map(([, name, table, seconds]) => ({ name, table, seconds }));

    expect(triggers).toEqual([
      {
        name: "delivery_event_writer_bound",
        table: "delivery_event",
        seconds: String(DELIVERY_EVENT_WRITER_BOUND_MS / 1000),
      },
      {
        name: "delivery_event_part_writer_bound",
        table: "delivery_event_part",
        seconds: String(DELIVERY_EVENT_WRITER_BOUND_MS / 1000),
      },
    ]);
  });

  it("is 240 s, and the least margin is twice it", () => {
    expect(DELIVERY_EVENT_WRITER_BOUND_MS).toBe(240_000);
    expect(FEED_FLOOR_MIN_MARGIN_MS).toBe(480_000);
    expect(FEED_FLOOR_DEFAULT_MARGIN_MS).toBe(600_000);
  });
});

describe("the margin", () => {
  it("accepts twice the bound and more, and nothing less", () => {
    expect(feedFloorMarginProblem(480_000)).toBeNull();
    expect(feedFloorMarginProblem(600_000)).toBeNull();
    expect(feedFloorMarginProblem(479_999)).toMatch(/FEED_FLOOR_MARGIN_MS/);
    expect(feedFloorMarginProblem(240_000)).toMatch(/480000/);
    expect(feedFloorMarginProblem(Number.NaN)).not.toBeNull();
  });

  it("defaults to 10 min at boot", () => {
    const parsed = parse({});

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.FEED_FLOOR_MARGIN_MS).toBe(600_000);
  });

  it("stops the boot when set under twice the bound", () => {
    const parsed = parse({ FEED_FLOOR_MARGIN_MS: "300000" });

    expect(parsed.success).toBe(false);
    expect(
      parsed.success
        ? []
        : parsed.error.issues.map((issue) => issue.path.join(".")),
    ).toContain("FEED_FLOOR_MARGIN_MS");
  });

  it("takes a larger margin, and an empty one as unset", () => {
    const larger = parse({ FEED_FLOOR_MARGIN_MS: "900000" });
    const empty = parse({ FEED_FLOOR_MARGIN_MS: "" });

    expect(larger.success && larger.data.FEED_FLOOR_MARGIN_MS).toBe(900_000);
    expect(empty.success && empty.data.FEED_FLOOR_MARGIN_MS).toBe(600_000);
  });
});

describe("the floor", () => {
  it("is the last served event's created_at minus the margin", () => {
    const at = new Date("2026-11-18T12:00:00.000Z");

    expect(feedFloorMs(at, 600_000)).toBe(at.getTime() - 600_000);
  });

  it("never goes below the uuid v7 epoch", () => {
    expect(feedFloorMs(new Date(1_000), 600_000)).toBe(0);
  });
});
