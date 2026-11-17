import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import {
  addGrains,
  freezeWindow,
  partitionName,
  partitionStartFromName,
  plannedPartitions,
  registeredPartitions,
  retentionCutoff,
  type PartitionedTable,
} from "@/shared/database/partitions";

/**
 * The registry the partition-maintenance job, the metrics and the alerts
 * read (plano-escala F2-08). Pure: names, bounds and cutoffs from a given
 * instant, in UTC.
 *
 * Why each case: a partition name that does not sort in time breaks the
 * retention; a required partition the job does not know is required is a
 * night of refused pings with no failed run to see; a cutoff a day off
 * drops a day of trail early; a table the job keeps that
 * infra/sql/10-partitions.sql does not own cannot be maintained once the
 * runtime stops being a superuser.
 */
const NIGHT = new Date("2026-11-17T04:10:00Z");

const trail = registeredPartitions({
  DRIVER_POSITION_RETENTION_DAYS: 90,
  DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
})[0];

const monthly: PartitionedTable = {
  table: "delivery_event_part",
  grain: "month",
  lookahead: 2,
  requiredBehind: 0,
  requiredAhead: 1,
  retentionDays: 365,
  settleDays: 7,
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("the partition registry", () => {
  it("keeps driver_position daily, from yesterday through the lookahead, with three required", () => {
    const planned = plannedPartitions(trail, NIGHT);

    expect(planned.map((each) => each.name)).toEqual([
      "driver_position_20261116",
      "driver_position_20261117",
      "driver_position_20261118",
      "driver_position_20261119",
      "driver_position_20261120",
      "driver_position_20261121",
      "driver_position_20261122",
      "driver_position_20261123",
      "driver_position_20261124",
    ]);
    expect(
      planned.filter((each) => each.required).map((each) => each.name),
    ).toEqual([
      "driver_position_20261116",
      "driver_position_20261117",
      "driver_position_20261118",
    ]);
    expect(planned[0]).toMatchObject({
      from: day("2026-11-16"),
      to: day("2026-11-17"),
    });
  });

  it("crosses a month and a year in UTC days", () => {
    const planned = plannedPartitions(trail, new Date("2026-12-30T23:59:00Z"));

    expect(planned.map((each) => each.name).slice(0, 4)).toEqual([
      "driver_position_20261229",
      "driver_position_20261230",
      "driver_position_20261231",
      "driver_position_20270101",
    ]);
  });

  it("plans a monthly table by month, with this month and the next required", () => {
    const planned = plannedPartitions(monthly, NIGHT);

    expect(planned.map((each) => [each.name, each.required])).toEqual([
      ["delivery_event_part_202611", true],
      ["delivery_event_part_202612", true],
      ["delivery_event_part_202701", false],
    ]);
    expect(planned[1]).toMatchObject({
      from: day("2026-12-01"),
      to: day("2027-01-01"),
    });
  });

  it("reads a partition's start back from its name, and nothing else's", () => {
    expect(partitionStartFromName(trail, "driver_position_20260228")).toEqual(
      day("2026-02-28"),
    );
    expect(
      partitionStartFromName(monthly, "delivery_event_part_202602"),
    ).toEqual(day("2026-02-01"));

    // Another table's partition, and dates that are not dates.
    expect(
      partitionStartFromName(trail, "driver_position_v2_20260228"),
    ).toBeNull();
    expect(
      partitionStartFromName(trail, "driver_position_20260230"),
    ).toBeNull();
    expect(partitionStartFromName(trail, "driver_position_2026022")).toBeNull();
    expect(partitionName(trail, day("2026-02-28"))).toBe(
      "driver_position_20260228",
    );
  });

  it("cuts the retention at a whole UTC day, retention days before today", () => {
    expect(retentionCutoff(trail, NIGHT)).toEqual(day("2026-08-19"));

    // The day that ends at the cutoff goes; the one that starts there stays.
    const lastDropped = day("2026-08-18");

    expect(addGrains("day", lastDropped, 1)).toEqual(
      retentionCutoff(trail, NIGHT),
    );
  });

  it("freezes on Sundays what ended between 8 and 22 days ago", () => {
    expect(freezeWindow(trail, new Date("2026-11-15T04:10:00Z"))).toEqual({
      endsAfter: day("2026-10-24"),
      endsBy: day("2026-11-07"),
    });
  });

  it("follows the environment for the trail's retention and lookahead", () => {
    const [configured] = registeredPartitions({
      DRIVER_POSITION_RETENTION_DAYS: 30,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 14,
    });

    expect(configured).toMatchObject({ retentionDays: 30, lookahead: 14 });
    expect(plannedPartitions(configured, NIGHT)).toHaveLength(16);
  });

  it("is owned by infra/sql/10-partitions.sql, table by table", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "infra/sql/10-partitions.sql"),
      "utf8",
    );
    const listed = /parents CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(sql);

    expect(listed).not.toBeNull();

    const parents = [...(listed?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map(
      (match) => match[1],
    );

    for (const table of registeredPartitions()) {
      expect(parents, table.table).toContain(table.table);
    }
  });
});

describe("the trail's partition environment", () => {
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

  it("defaults to 90 days kept and 7 ahead, as the job always did, empty included", () => {
    for (const value of [undefined, ""]) {
      const parsed = parse(
        value === undefined
          ? {}
          : {
              DRIVER_POSITION_RETENTION_DAYS: value,
              DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: value,
            },
      );

      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({
        DRIVER_POSITION_RETENTION_DAYS: 90,
        DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
      });
    }
  });

  it("refuses a lookahead under 7, which the lookahead alert would page on every night", () => {
    expect(
      parse({ DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: "6" }).success,
    ).toBe(false);
    expect(parse({ DRIVER_POSITION_RETENTION_DAYS: "0" }).success).toBe(false);
    expect(
      parse({
        DRIVER_POSITION_RETENTION_DAYS: "30",
        DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: "14",
      }).data,
    ).toMatchObject({
      DRIVER_POSITION_RETENTION_DAYS: 30,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 14,
    });
  });
});
