import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  EXHAUSTED_CLOSE_BATCH,
  EXHAUSTED_CLOSE_INTERVAL_MS,
  EXHAUSTED_CLOSE_MAX_BATCHES,
  EXHAUSTED_REASON,
  closeExhaustedInBatches,
  exhaustedCloseSql,
} from "@/shared/queue/exhausted-close";

/**
 * The exhausted rows closed off the claims' path (plano-escala F3-08).
 *
 * Every claim used to close, first, the rows whose last attempt died with
 * their process, through the claim's own index: a flood of due rows made
 * each claim read the flood. A minute's timer does it now. What this pins:
 *
 *  - the statement: only PROCESSING rows whose lease ran out at the
 *    ceiling, at most 500 under SKIP LOCKED, with the reason the dead letter
 *    shows, and the claim floor on both levels;
 *  - the lanes' channels inlined as the constants they are, and nothing
 *    else accepted there;
 *  - the sweep: batch after batch while they come back full, never more
 *    than twenty a minute.
 */

const floor = Prisma.sql` AND "id" >= ${"a"} AND "id" < ${"b"}`;

describe("the close statement", () => {
  it("takes only the rows whose last attempt died, a batch at a time, skipping the locked ones", () => {
    const sql = exhaustedCloseSql({
      table: "notification_delivery",
      maxAttempts: 7,
      floor,
      channels: ["EMAIL", "WHATSAPP"],
    });

    const text = sql.text.replace(/\s+/g, " ");

    expect(text).toContain(
      'UPDATE "notification_delivery" SET "status" = \'FAILED\'',
    );
    expect(text).toContain('"leaseExpiresAt" = NULL');
    expect(text).toContain(
      'WHERE "status" = \'PROCESSING\' AND "leaseExpiresAt" < now() AND "attempts" >= $2',
    );
    expect(text).toContain("\"channel\" IN ('EMAIL', 'WHATSAPP')");
    expect(text).toContain(`LIMIT $5 FOR UPDATE SKIP LOCKED`);

    // The floor on the subselect and on the UPDATE, as in the claims.
    expect(text.match(/"id" >= \$/g)).toHaveLength(2);

    expect(sql.values).toEqual([
      EXHAUSTED_REASON,
      7,
      "a",
      "b",
      EXHAUSTED_CLOSE_BATCH,
      "a",
      "b",
    ]);
    expect(EXHAUSTED_CLOSE_BATCH).toBe(500);
  });

  it("writes the reason the claims always wrote", () => {
    expect(EXHAUSTED_REASON).toBe(
      "O processo foi interrompido durante a última tentativa permitida.",
    );
  });

  it("names no channel for the queues without lanes", () => {
    const sql = exhaustedCloseSql({
      table: "webhook_delivery",
      maxAttempts: 6,
      floor: Prisma.empty,
    });

    expect(sql.text).toContain('UPDATE "webhook_delivery"');
    expect(sql.text).not.toContain('"channel"');
  });

  it("refuses a channel that is not a constant's spelling", () => {
    expect(() =>
      exhaustedCloseSql({
        table: "notification_delivery",
        maxAttempts: 7,
        floor: Prisma.empty,
        channels: ["EMAIL') OR ('1' = '1"],
      }),
    ).toThrow(/canal inválido/);
  });
});

describe("the sweep", () => {
  it("runs once a minute", () => {
    expect(EXHAUSTED_CLOSE_INTERVAL_MS).toBe(60_000);
  });

  it("goes on while the batches come back full, and stops at the first short one", async () => {
    const batches = [
      EXHAUSTED_CLOSE_BATCH,
      EXHAUSTED_CLOSE_BATCH,
      12,
      EXHAUSTED_CLOSE_BATCH,
    ];
    let runs = 0;

    const closed = await closeExhaustedInBatches(async () => batches[runs++]);

    expect(runs).toBe(3);
    expect(closed).toBe(2 * EXHAUSTED_CLOSE_BATCH + 12);
  });

  it("leaves the rest for the next minute after twenty full batches", async () => {
    let runs = 0;

    const closed = await closeExhaustedInBatches(async () => {
      runs += 1;
      return EXHAUSTED_CLOSE_BATCH;
    });

    expect(runs).toBe(EXHAUSTED_CLOSE_MAX_BATCHES);
    expect(closed).toBe(EXHAUSTED_CLOSE_MAX_BATCHES * EXHAUSTED_CLOSE_BATCH);
  });
});
