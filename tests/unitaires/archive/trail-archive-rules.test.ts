import { describe, expect, it, vi } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import {
  TRAIL_CSV_COLUMNS,
  createTrailArchiveGate,
  csvCell,
  trailArchiveKey,
  trailSourceOf,
} from "@/shared/archive/trail-archive";
import { registeredPartitions } from "@/shared/database/partitions";

/**
 * The trail archive's pure rules and its gate without a bucket
 * (plano-escala F2-11). The database path is in tests/E2E/trail-archive.
 *
 * Why each case: the key is what makes a rerun rewrite the same object
 * instead of a second one, and what the bucket's Expiration rule on
 * `trail/` matches, so the legacy trail's day must not share a key with
 * the lean trail's; a CSV cell that is not quoted when it needs to be
 * shifts every column after it; enabled without the bucket, the job must
 * keep the expired days rather than drop them unarchived; and off by
 * default, a deploy changes nothing until the owner turns it on.
 */
const DAY = new Date("2026-10-01T00:00:00.000Z");
const COMPANY = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("trailArchiveKey", () => {
  it("names the lean trail's object by the partition's UTC day and the company", () => {
    const lean = trailSourceOf("driver_position_v2");

    expect(lean).not.toBeNull();
    expect(trailArchiveKey(lean!, DAY, COMPANY)).toBe(
      `trail/20261001/${COMPANY}.csv.gz`,
    );
  });

  it("puts the legacy trail's day under legacy/, never on the lean trail's key", () => {
    const legacy = trailSourceOf("driver_position");

    expect(trailArchiveKey(legacy!, DAY, COMPANY)).toBe(
      `trail/20261001/legacy/${COMPANY}.csv.gz`,
    );
  });

  it("zero-pads the day, so keys sort in time", () => {
    expect(
      trailArchiveKey(
        trailSourceOf("driver_position_v2")!,
        new Date("2026-02-03T00:00:00Z"),
        COMPANY,
      ),
    ).toBe(`trail/20260203/${COMPANY}.csv.gz`);
  });

  it("knows only the two trail tables", () => {
    expect(trailSourceOf("delivery_event_part")).toBeNull();
  });
});

describe("csvCell", () => {
  it("writes null as empty, numbers exactly and instants in UTC", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(-23.550520123456789)).toBe("-23.55052012345679");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(new Date("2026-10-01T12:34:56.789Z"))).toBe(
      "2026-10-01T12:34:56.789Z",
    );
  });

  it("quotes only a value with a comma, a quote or a line break", () => {
    expect(csvCell(COMPANY)).toBe(COMPANY);
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("starts every object with the same header", () => {
    expect(TRAIL_CSV_COLUMNS.join(",")).toBe(
      "driver_id,recorded_at,route_id,latitude,longitude,accuracy,speed,heading,battery",
    );
  });
});

describe("the trail archive gate without a bucket", () => {
  const partition = {
    name: "driver_position_v2_20261001",
    from: DAY,
    to: new Date("2026-10-02T00:00:00Z"),
  };

  it("keeps every expired day of a trail table, and touches nothing", async () => {
    const db = {
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    };
    const gate = createTrailArchiveGate({
      db: db as never,
      storage: null,
      missing: ["TRAIL_ARCHIVE_BUCKET"],
      deadline: Date.now() + 60_000,
      retentionDays: 180,
    });

    expect(await gate.ensureArchived("driver_position_v2", partition)).toBe(
      false,
    );
    expect(await gate.ensureArchived("driver_position", partition)).toBe(false);

    await gate.housekeeping();

    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("lets a table that is not a trail through", async () => {
    const gate = createTrailArchiveGate({
      db: {} as never,
      storage: null,
      deadline: Date.now(),
      retentionDays: 180,
    });

    expect(
      await gate.ensureArchived("delivery_event_part", {
        ...partition,
        name: "delivery_event_part_202610",
      }),
    ).toBe(true);
    expect(await gate.mayDropDetached("delivery_event_part", "x")).toBe(true);
  });

  it("drops a detached day only with its archive verified, and keeps it when the check fails", async () => {
    const answers = [[{ present: true }], [{ present: false }]];
    const db = {
      $queryRawUnsafe: vi.fn(async () => answers.shift()),
      $executeRawUnsafe: vi.fn(),
    };
    const gate = createTrailArchiveGate({
      db: db as never,
      storage: null,
      deadline: Date.now(),
      retentionDays: 180,
    });

    expect(await gate.mayDropDetached("driver_position_v2", "a")).toBe(true);
    expect(await gate.mayDropDetached("driver_position_v2", "b")).toBe(false);

    db.$queryRawUnsafe.mockRejectedValueOnce(new Error("banco fora"));

    expect(await gate.mayDropDetached("driver_position_v2", "c")).toBe(false);
  });
});

describe("the trail registry and the archive", () => {
  it("marks both trail tables for the archive, and nothing else", () => {
    const archived = registeredPartitions()
      .filter((table) => table.archive === "trail")
      .map((table) => table.table)
      .sort();

    expect(archived).toEqual(["driver_position", "driver_position_v2"]);

    for (const table of archived) expect(trailSourceOf(table)).not.toBeNull();
  });
});

describe("the trail archive's environment", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

  it("is off by default, in Infrequent Access and 180 days, empty included", () => {
    for (const overrides of [
      {} as Record<string, string>,
      {
        TRAIL_ARCHIVE_ENABLED: "",
        ARCHIVE_STORAGE_CLASS: "",
        TRAIL_ARCHIVE_RETENTION_DAYS: "",
      },
    ]) {
      const parsed = parse(overrides);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({
        TRAIL_ARCHIVE_ENABLED: false,
        ARCHIVE_STORAGE_CLASS: "STANDARD_IA",
        TRAIL_ARCHIVE_RETENTION_DAYS: 180,
      });
      expect(parsed.data?.TRAIL_ARCHIVE_BUCKET).toBeUndefined();
    }
  });

  it("boots when switched on without the bucket, warning instead of refusing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const parsed = parse({ TRAIL_ARCHIVE_ENABLED: "true" });

      expect(parsed.success).toBe(true);
      expect(parsed.data?.TRAIL_ARCHIVE_ENABLED).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("TRAIL_ARCHIVE_BUCKET"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a storage class R2 does not have and a retention under 30 days", () => {
    expect(parse({ ARCHIVE_STORAGE_CLASS: "GLACIER" }).success).toBe(false);
    expect(parse({ TRAIL_ARCHIVE_RETENTION_DAYS: "29" }).success).toBe(false);
    expect(parse({ TRAIL_ARCHIVE_ENABLED: "yes" }).success).toBe(false);
  });
});
