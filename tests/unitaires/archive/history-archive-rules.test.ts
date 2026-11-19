import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_ARCHIVE_COLUMNS,
  DELIVERY_EVENT_ARCHIVE_COLUMNS,
  HISTORY_SOURCES,
  historyArchiveKey,
  historyCsvCell,
  historyCsvLine,
  historyPeriod,
} from "@/shared/archive/history-archive";
import {
  normalizePeriod,
  parseHistoryCsv,
} from "@/shared/archive/history-restore";
import { createPartitionArchiveJob } from "@/shared/jobs/partition-archive";
import { PermanentJobError } from "@/shared/jobs/job-errors";

/**
 * The history archive's rules (plano-escala F5-16), the ones that decide
 * whether a month that left the database can come back as it was:
 *
 *  - the CSV carries every column of the table: a column added to the model
 *    and left out of the archive would be lost with the DROP of F5-17;
 *  - NULL and the empty string stay apart, and commas, quotes and line
 *    breaks survive the round trip of archive-restore's parser;
 *  - the keys and the periods are the ones the bucket's lifecycle and the
 *    restore expect;
 *  - the job refuses a table it does not archive, and a process without
 *    the archive's settings.
 */
describe("the archive's columns", () => {
  it("are every column of delivery_event Prisma reads, in its order", () => {
    expect([...DELIVERY_EVENT_ARCHIVE_COLUMNS]).toEqual(
      Object.keys(Prisma.DeliveryEventScalarFieldEnum),
    );
  });

  it("are every column of activity, in its order", () => {
    expect([...ACTIVITY_ARCHIVE_COLUMNS]).toEqual(
      Object.keys(Prisma.ActivityScalarFieldEnum),
    );
  });
});

describe("the archive's CSV", () => {
  it("writes NULL as an empty cell and an empty string as a quoted one", () => {
    expect(historyCsvCell(null)).toBe("");
    expect(historyCsvCell("")).toBe('""');
    expect(historyCsvCell("simples")).toBe("simples");
    expect(historyCsvCell("a,b")).toBe('"a,b"');
    expect(historyCsvCell('ele disse "oi"')).toBe('"ele disse ""oi"""');
    expect(historyCsvCell("linha\nquebrada")).toBe('"linha\nquebrada"');
  });

  it("comes back from the restore's parser exactly as it went", () => {
    const records: Array<Array<string | null>> = [
      ["id", "note", "gps_address"],
      ["1", null, '{"line":"Rua A, 10","city":"São Paulo"}'],
      ["2", "", "fim de linha\r\ncom CRLF"],
      ["3", '"aspas" no começo', null],
      ["4", ",", '""'],
    ];
    const text = records.map(historyCsvLine).join("");

    expect(parseHistoryCsv(text)).toEqual(records);
  });

  it("refuses a CSV cut in the middle of a quoted cell", () => {
    expect(() => parseHistoryCsv('a,"b\n')).toThrow(/truncado/);
  });
});

describe("the archive's keys and periods", () => {
  const events = HISTORY_SOURCES.delivery_event;

  it("names an object by table, month (or older) and company", () => {
    expect(historyArchiveKey(events, "delivery_event_202611", "b1")).toBe(
      "archive/delivery_event/202611/b1.csv.gz",
    );
    expect(historyArchiveKey(events, "delivery_event_older", "b1")).toBe(
      "archive/delivery_event/older/b1.csv.gz",
    );
    expect(() =>
      historyArchiveKey(events, "delivery_event_legacy", "b1"),
    ).toThrow();
    expect(historyPeriod(events, "activity_202611")).toBeNull();
  });

  it("takes a period as AAAAMM, AAAA-MM or older, and nothing else", () => {
    expect(normalizePeriod("2026-11")).toBe("202611");
    expect(normalizePeriod("202611")).toBe("202611");
    expect(normalizePeriod("OLDER")).toBe("older");
    expect(() => normalizePeriod("2026-13")).toThrow();
    expect(() => normalizePeriod("novembro")).toThrow();
  });
});

describe("the PARTITION_ARCHIVE job", () => {
  const job = (payload: Record<string, unknown>) =>
    ({
      id: "job-1",
      payload,
      throwIfStopped: () => undefined,
      checkpoint: async () => undefined,
    }) as never;

  it("refuses a table that is neither the trail nor the history", async () => {
    const handler = createPartitionArchiveJob({
      db: {} as never,
      storage: () => null,
    });

    await expect(
      handler.run(
        job({ table: "user", name: "user_202611", from: "", to: "2026-12-01" }),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("refuses a history partition in a process without the archive's settings", async () => {
    const handler = createPartitionArchiveJob({
      db: {} as never,
      storage: () => null,
      missing: () => ["TRAIL_ARCHIVE_BUCKET"],
    });

    await expect(
      handler.run(
        job({
          table: "activity",
          name: "activity_older",
          from: "",
          to: "2026-10-01T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/TRAIL_ARCHIVE_BUCKET/);
  });
});
