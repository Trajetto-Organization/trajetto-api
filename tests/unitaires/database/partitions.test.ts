import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import {
  NOTIFICATION_LOOKAHEAD_MONTHS,
  NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT,
  OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT,
  QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT,
  QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT,
  WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT,
  addGrains,
  freezeWindow,
  partitionBound,
  partitionName,
  partitionStartFromName,
  plannedPartitions,
  registeredPartitions,
  retentionCutoff,
  type PartitionedTable,
} from "@/shared/database/partitions";
import { REPLAY_WINDOW_DAYS } from "@/shared/integration/webhook-dispatch-rules";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

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
  key: "uuid7",
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

  // plano-escala F2-16: the delivery trail's shell. Its bounds are ids,
  // and nothing of it is ever detached: a wrong bound refuses events, a
  // retention would drop the delivery history the legal opinion keeps.
  it("keeps the delivery trail's shell monthly on its uuid v7 id, three months ahead and never dropped", () => {
    const shell = registeredPartitions().find(
      (table) => table.table === "delivery_event_part",
    );

    expect(shell).toMatchObject({
      grain: "month",
      key: "uuid7",
      lookahead: 3,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: null,
    });

    const planned = plannedPartitions(shell as PartitionedTable, NIGHT);

    expect(planned.map((each) => [each.name, each.required])).toEqual([
      ["delivery_event_part_202610", true],
      ["delivery_event_part_202611", true],
      ["delivery_event_part_202612", true],
      ["delivery_event_part_202701", false],
      ["delivery_event_part_202702", false],
    ]);

    // Kept: the cutoff is the epoch, which no partition ends before.
    expect(retentionCutoff(shell as PartitionedTable, NIGHT)).toEqual(
      new Date(0),
    );
  });

  // plano-escala F2-17: the copy window renames the shell to delivery_event.
  // From that night the same months are kept under the trail's own name,
  // and the shell's absence is the expected state; before it, the trail is
  // a plain table the job leaves alone.
  it("keeps the delivery trail under its own name after the window, the shell gone on purpose", () => {
    const tables = registeredPartitions();
    const shell = tables.find((table) => table.table === "delivery_event_part");
    const trail = tables.find((table) => table.table === "delivery_event");

    expect(shell?.shellUntilWindow).toBe(true);
    expect(trail).toMatchObject({
      grain: "month",
      key: "uuid7",
      lookahead: 3,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: null,
      plainUntilSwap: true,
    });
    expect(trail?.shellUntilWindow).toBeUndefined();

    expect(
      plannedPartitions(trail as PartitionedTable, NIGHT).map(
        (each) => each.name,
      ),
    ).toEqual([
      "delivery_event_202610",
      "delivery_event_202611",
      "delivery_event_202612",
      "delivery_event_202701",
      "delivery_event_202702",
    ]);
  });

  it("writes a bound in the key's own terms: a UTC timestamp, or the smallest uuid v7 of the instant", () => {
    expect(partitionBound(trail, day("2026-11-17"))).toBe(
      "'2026-11-17T00:00:00.000Z'",
    );
    expect(partitionBound(monthly, day("2026-11-01"))).toBe(
      "'01a19467-e800-0000-0000-000000000000'",
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

/**
 * The four queues (plano-escala F5-07): daily on their uuid v7 id from the
 * swap of F5-09 on, a week ahead by default, nothing dropped by the job
 * yet, each new partition with the storage parameters its plain table has
 * today (a partitioned parent cannot carry them). Until the swap they are
 * plain tables the job leaves alone.
 */
describe("the queues in the registry", () => {
  const queues = () =>
    registeredPartitions({
      DRIVER_POSITION_RETENTION_DAYS: 90,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
    }).filter((table) => table.plainUntilSwap && table.grain === "day");

  it("are the four, daily by id, plain until the swap", () => {
    expect(queues().map((table) => table.table)).toEqual([
      "domain_outbox_event",
      "notification_delivery",
      "notification_provider_receipt",
      "webhook_delivery",
    ]);

    for (const table of queues()) {
      expect(table, table.table).toMatchObject({
        grain: "day",
        key: "uuid7",
        lookahead: QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT,
        requiredBehind: 1,
        requiredAhead: 1,
        stuckGraceDays: QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT,
      });
    }

    expect(QUEUE_PARTITION_LOOKAHEAD_DAYS_DEFAULT).toBe(7);
    expect(QUEUE_PARTITION_STUCK_ALERT_DAYS_DEFAULT).toBe(3);
  });

  it("drop the notification family and the webhook ledger by day, each through its gate", () => {
    // F5-11: the events, deliveries and receipts leave whole days after
    // OUTBOX_PUBLISHED_RETENTION_DAYS, settled first by the gate.
    const byTable = Object.fromEntries(
      queues().map((table) => [table.table, table]),
    );

    for (const name of [
      "domain_outbox_event",
      "notification_delivery",
      "notification_provider_receipt",
    ]) {
      expect(byTable[name], name).toMatchObject({
        retentionDays: OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT,
        dropGate: "notification-family",
      });
    }

    expect(OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT).toBe(30);
    // F5-12: the ledger leaves after the replay window plus a day.
    expect(byTable.webhook_delivery).toMatchObject({
      retentionDays: WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT,
      dropGate: "webhook-deliveries",
    });
    expect(WEBHOOK_DELIVERY_RETENTION_DAYS_DEFAULT).toBe(
      REPLAY_WINDOW_DAYS + 1,
    );

    const configured = registeredPartitions({
      DRIVER_POSITION_RETENTION_DAYS: 90,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
      OUTBOX_PUBLISHED_RETENTION_DAYS: 45,
      QUEUE_PARTITION_STUCK_ALERT_DAYS: 5,
    }).find((table) => table.table === "notification_delivery");

    expect(configured).toMatchObject({ retentionDays: 45, stuckGraceDays: 5 });
  });

  it("make yesterday through a week ahead, bounded by the smallest v7 of each day", () => {
    const [outbox] = queues();
    const planned = plannedPartitions(outbox, NIGHT);

    expect(planned).toHaveLength(9);
    expect(planned[0]).toMatchObject({
      name: "domain_outbox_event_20261116",
      required: true,
    });
    expect(planned[planned.length - 1].name).toBe(
      "domain_outbox_event_20261124",
    );
    expect(partitionBound(outbox, day("2026-11-17"))).toBe(
      `'${uuid7Floor(day("2026-11-17"))}'`,
    );
  });

  it("give each new partition its table's storage parameters", () => {
    const options = Object.fromEntries(
      queues().map((table) => [table.table, table.reloptions ?? []]),
    );

    expect(options).toEqual({
      domain_outbox_event: [
        "autovacuum_vacuum_scale_factor=0.01",
        "autovacuum_analyze_scale_factor=0.01",
        "autovacuum_vacuum_cost_delay=2",
        "fillfactor=70",
      ],
      notification_delivery: [
        "autovacuum_vacuum_scale_factor=0.01",
        "autovacuum_analyze_scale_factor=0.01",
        "autovacuum_vacuum_cost_delay=2",
        "fillfactor=70",
      ],
      notification_provider_receipt: [],
      webhook_delivery: [
        "autovacuum_vacuum_scale_factor=0.01",
        "autovacuum_analyze_scale_factor=0.01",
        "fillfactor=70",
      ],
    });
  });

  it("follow QUEUE_PARTITION_LOOKAHEAD_DAYS, which refuses less than a week", () => {
    const configured = registeredPartitions({
      DRIVER_POSITION_RETENTION_DAYS: 90,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
      QUEUE_PARTITION_LOOKAHEAD_DAYS: 14,
    }).filter((table) => table.plainUntilSwap && table.grain === "day");

    expect(configured.every((table) => table.lookahead === 14)).toBe(true);

    const parse = (value: string) =>
      envSchema.safeParse(
        definedEnv({
          NODE_ENV: "development",
          REDIS_URL: "redis://localhost:6379",
          HTTP_REQUEST: "http://localhost:3000",
          JWT_SECRET: "a".repeat(32),
          JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
          MASTER_USER_EMAIL: "master@example.com",
          MASTER_USER_INITIAL_PASSWORD: "x",
          QUEUE_PARTITION_LOOKAHEAD_DAYS: value,
        }),
      );

    const empty = parse("");

    expect(parse("6").success).toBe(false);
    expect(empty.success && empty.data?.QUEUE_PARTITION_LOOKAHEAD_DAYS).toBe(7);
  });
});

/**
 * The bell (plano-escala F5-15): monthly on its uuid v7 id from the swap
 * of 20-notification-partition-swap.sql on, two months ahead, a month
 * dropped whole past the unread retention (every row then past both), no
 * gate: nothing in the bell is ever in flight.
 */
describe("the bell in the registry", () => {
  it("is monthly by id, plain until its swap, and kept as long as an unread notification", () => {
    const [bell] = registeredPartitions({
      DRIVER_POSITION_RETENTION_DAYS: 90,
      DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
    }).filter((table) => table.table === "notification");

    expect(bell).toMatchObject({
      grain: "month",
      key: "uuid7",
      lookahead: NOTIFICATION_LOOKAHEAD_MONTHS,
      requiredBehind: 1,
      requiredAhead: 1,
      retentionDays: NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT,
      plainUntilSwap: true,
    });
    expect(bell.dropGate).toBeUndefined();
    expect(NOTIFICATION_UNREAD_RETENTION_DAYS_DEFAULT).toBe(180);
    expect(plannedPartitions(bell, NIGHT).map((each) => each.name)).toEqual([
      "notification_202610",
      "notification_202611",
      "notification_202612",
      "notification_202701",
    ]);
    expect(
      registeredPartitions({
        DRIVER_POSITION_RETENTION_DAYS: 90,
        DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
        NOTIFICATION_UNREAD_RETENTION_DAYS: 365,
      }).find((table) => table.table === "notification")?.retentionDays,
    ).toBe(365);
  });
});

describe("the queues' retention environment", () => {
  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(
      definedEnv({
        NODE_ENV: "development",
        REDIS_URL: "redis://localhost:6379",
        HTTP_REQUEST: "http://localhost:3000",
        JWT_SECRET: "a".repeat(32),
        JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
        MASTER_USER_EMAIL: "master@example.com",
        MASTER_USER_INITIAL_PASSWORD: "x",
        ...overrides,
      }),
    );

  it("keeps the family 30 days and pages after 3, empty included", () => {
    const variants: Array<Record<string, string>> = [
      {},
      {
        OUTBOX_PUBLISHED_RETENTION_DAYS: "",
        QUEUE_PARTITION_STUCK_ALERT_DAYS: "",
      },
    ];

    for (const overrides of variants) {
      const parsed = parse(overrides);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({
        OUTBOX_PUBLISHED_RETENTION_DAYS: 30,
        QUEUE_PARTITION_STUCK_ALERT_DAYS: 3,
      });
    }
  });

  it("refuses a family retention an unclaimed receipt's anchor would outlive", () => {
    // receipt-id.ts anchors a receipt nobody claims up to 30 days back:
    // a day dropped sooner would refuse it.
    expect(parse({ OUTBOX_PUBLISHED_RETENTION_DAYS: "29" }).success).toBe(
      false,
    );
    expect(parse({ OUTBOX_PUBLISHED_RETENTION_DAYS: "91" }).success).toBe(
      false,
    );
    expect(parse({ QUEUE_PARTITION_STUCK_ALERT_DAYS: "0" }).success).toBe(
      false,
    );
  });

  it("keeps the webhook ledger at least the replay window plus a day", () => {
    // A resend of anything younger than REPLAY_WINDOW_DAYS is accepted,
    // from its created_at: a shorter retention would drop a row a person
    // can still resend (F5-12).
    expect(parse({}).data?.WEBHOOK_DELIVERY_RETENTION_DAYS).toBe(
      REPLAY_WINDOW_DAYS + 1,
    );
    expect(
      parse({ WEBHOOK_DELIVERY_RETENTION_DAYS: String(REPLAY_WINDOW_DAYS) })
        .success,
    ).toBe(false);
    expect(
      parse({ WEBHOOK_DELIVERY_RETENTION_DAYS: "45" }).data
        ?.WEBHOOK_DELIVERY_RETENTION_DAYS,
    ).toBe(45);
  });

  it("refuses a dead letter that keeps a failure no longer than the queue did", () => {
    // A FAILED event moves to its dead letter at the family's retention.
    const refused = parse({
      OUTBOX_PUBLISHED_RETENTION_DAYS: "60",
      OUTBOX_FAILED_RETENTION_DAYS: "60",
    });

    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain(
      "OUTBOX_FAILED_RETENTION_DAYS",
    );
    expect(
      parse({
        OUTBOX_PUBLISHED_RETENTION_DAYS: "60",
        OUTBOX_FAILED_RETENTION_DAYS: "61",
      }).success,
    ).toBe(true);
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
