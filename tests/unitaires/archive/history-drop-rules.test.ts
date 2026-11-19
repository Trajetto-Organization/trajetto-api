import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import {
  historyRetentionDays,
  registeredPartitions,
} from "@/shared/database/partitions";

/**
 * The history's DROP switches (plano-escala F5-17, decision D3).
 *
 * The history is the transport companies' fiscal record (NF-e and CT-e
 * keys): until the lawyer's opinion nothing of it may leave the database,
 * and after it only HISTORY_ATTACHED_MONTHS after a month ends. The E2E
 * history-drop proves the gate; these, the switches around it:
 *
 *  - off by default, the registry keeps both tables (no retention, so the
 *    partition job never even looks at a partition of them to drop);
 *  - on, the retention is 31 days a month, never fewer calendar months;
 *  - the months kept attached must end before the archive does, or the
 *    boot is refused.
 */
/** What a development boot needs; the history's variables are left unset. */
const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const history = (values: Parameters<typeof registeredPartitions>[0]) =>
  registeredPartitions(values).filter((table) => table.archive === "history");

const minimal = {
  DRIVER_POSITION_RETENTION_DAYS: 90,
  DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: 7,
};

describe("the history's DROP switches", () => {
  it("default to off: delivery_event and activity are kept", () => {
    const parsed = envSchema.parse(base);

    expect(parsed.HISTORY_DROP_ENABLED).toBe(false);
    expect(parsed.HISTORY_ATTACHED_MONTHS).toBe(24);
    expect(parsed.HISTORY_ARCHIVE_RETENTION_YEARS).toBe(5);

    expect(history(minimal).map((table) => table.table)).toEqual([
      "delivery_event",
      "activity",
    ]);

    for (const table of history(minimal)) {
      expect(table.retentionDays, table.table).toBeNull();
    }
  });

  it("on, keep HISTORY_ATTACHED_MONTHS of 31 days each", () => {
    expect(
      historyRetentionDays({ ...minimal, HISTORY_DROP_ENABLED: true }),
    ).toBe(24 * 31);

    for (const table of history({
      ...minimal,
      HISTORY_DROP_ENABLED: true,
      HISTORY_ATTACHED_MONTHS: 36,
    })) {
      expect(table.retentionDays, table.table).toBe(36 * 31);
    }

    // The shells of the copy window are never the history's.
    expect(
      registeredPartitions({ ...minimal, HISTORY_DROP_ENABLED: true })
        .filter((table) => table.table.endsWith("_part"))
        .every((table) => table.retentionDays === null && !table.archive),
    ).toBe(true);
  });

  it("refuse months kept attached that outlast the archive", () => {
    const refused = envSchema.safeParse({
      ...base,
      HISTORY_ATTACHED_MONTHS: "60",
      HISTORY_ARCHIVE_RETENTION_YEARS: "5",
    });

    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain(
      "HISTORY_ATTACHED_MONTHS",
    );

    expect(
      envSchema.safeParse({
        ...base,
        HISTORY_ATTACHED_MONTHS: "59",
        HISTORY_ARCHIVE_RETENTION_YEARS: "5",
      }).success,
    ).toBe(true);
  });

  it("take an empty value as unset", () => {
    const parsed = envSchema.parse({
      ...base,
      HISTORY_DROP_ENABLED: "",
      HISTORY_ATTACHED_MONTHS: "",
      HISTORY_ARCHIVE_RETENTION_YEARS: "",
    });

    expect(parsed).toMatchObject({
      HISTORY_DROP_ENABLED: false,
      HISTORY_ATTACHED_MONTHS: 24,
      HISTORY_ARCHIVE_RETENTION_YEARS: 5,
    });
  });
});
