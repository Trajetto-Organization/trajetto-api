import { describe, expect, it } from "vitest";

import { envShape } from "@/schemas/env-schema/defined-env";
import {
  OUTBOX_EXPANSION_BATCH_MAX_ROWS,
  OUTBOX_EXPANSION_BATCH_SIZE,
  byCreation,
  chunkByRows,
  outboxPublishedBatchSql,
} from "@/shared/notifications/notification-pipeline-service";

/**
 * The pure parts of the outbox's batch expansion (plano-escala F5-33).
 *
 * The batch mode writes the deliveries of up to 50 events in one
 * transaction and marks them PUBLISHED in one statement. What could go
 * wrong without a database: the mode switched on by an empty variable, a
 * mark that publishes an event another replica took over (the fencing of
 * each event must be in the statement), one event's rows split across two
 * transactions, or the deliveries written in another order than their
 * facts happened. The rows themselves are proven against a real database
 * by tests/E2E/outbox-batch-expansion.test.ts.
 */
const mode = () => envShape().OUTBOX_EXPANSION_MODE;

const event = (id: string, at: string) => ({
  id,
  topic: "fuel.created",
  payload: {},
  businessId: null,
  actorId: null,
  attempts: 1,
  created_at: new Date(at),
  correlationId: null,
});

describe("OUTBOX_EXPANSION_MODE", () => {
  it("is per-event unless batch is asked for, empty included", () => {
    expect(mode().parse(undefined)).toBe("per-event");
    expect(mode().parse("")).toBe("per-event");
    expect(mode().parse("batch")).toBe("batch");
    expect(mode().parse("per-event")).toBe("per-event");
  });

  it("refuses anything else, so a typo stops the boot", () => {
    expect(mode().safeParse("lote").success).toBe(false);
    expect(mode().safeParse("BATCH").success).toBe(false);
  });
});

describe("the batch's PUBLISHED mark", () => {
  it("is fenced per event by the status and the attempt it was claimed with", () => {
    const sql = outboxPublishedBatchSql([
      { id: "019a0000-0000-7000-8000-000000000001", attempts: 1 },
      { id: "019a0000-0000-7000-8000-000000000002", attempts: 3 },
    ]);

    expect(sql.sql).toContain(`e."status" = 'PROCESSING'`);
    expect(sql.sql).toContain(`e."attempts" = claimed."attempts"`);
    expect(sql.sql).toContain(`e."id" = claimed."id"`);
    expect(sql.sql).toContain(`"status" = 'PUBLISHED'`);
    // The client sets updated_at on every other write; a raw one must too.
    expect(sql.sql).toContain(`"updated_at" = now()`);
    expect(sql.values).toEqual([
      "019a0000-0000-7000-8000-000000000001",
      1,
      "019a0000-0000-7000-8000-000000000002",
      3,
    ]);
  });
});

describe("chunkByRows", () => {
  const expanded = (...sizes: number[]) =>
    sizes.map((size, index) => ({
      index,
      rows: Array.from({ length: size }, () => ({})),
    }));

  it("keeps a batch whole while its rows fit", () => {
    expect(chunkByRows(expanded(4, 4, 4)).map((c) => c.length)).toEqual([3]);
  });

  it("starts a new transaction before the cap, never inside an event", () => {
    const chunks = chunkByRows(expanded(3, 3, 3, 1), 6);

    expect(chunks.map((c) => c.map((each) => each.index))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("writes an event over the cap alone, as its own expansion did", () => {
    const chunks = chunkByRows(expanded(2, 9, 2), 6);

    expect(chunks.map((c) => c.map((each) => each.index))).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it("caps a batch's transaction well under the bind limit", () => {
    // Five columns a row: 2.000 rows are 10.000 parameters, of 65.535.
    expect(OUTBOX_EXPANSION_BATCH_MAX_ROWS * 5).toBeLessThan(65_535);
    expect(OUTBOX_EXPANSION_BATCH_SIZE).toBe(50);
  });
});

describe("byCreation", () => {
  it("orders a claim by when the facts happened, then by id", () => {
    const claimed = [
      event("c", "2026-11-19T10:00:02Z"),
      event("b", "2026-11-19T10:00:01Z"),
      event("a", "2026-11-19T10:00:01Z"),
    ];

    expect([...claimed].sort(byCreation).map((each) => each.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
