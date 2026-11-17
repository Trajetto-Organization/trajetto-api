import { describe, expect, it } from "vitest";

import {
  UNTIED_RECEIPT_RETENTION_DAYS,
  receiptAnchorMs,
  receiptIdFor,
} from "@/shared/notifications/receipt-id";
import { uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * The id of a provider receipt is decided by the fact it records
 * (plano-escala F5-04).
 *
 * Meta and Svix repeat a callback they did not see a 2xx for. Wave 10
 * (F5-06) drops the unique (provider, message id, status) that absorbed the
 * repeats, because the receipts become partitioned by day on their id: the
 * repeat must then compute the same primary key. And the id must start with
 * a day whose partition exists: the delivery's (its event's) when the
 * receipt is tied to one, else the day it happened, held inside the
 * untied receipts' retention.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-17T15:30:00.000Z");
const MIDNIGHT = Date.parse("2026-11-17T00:00:00.000Z");

const DELIVERY = "019a9a2e-5c00-7abc-8def-0123456789ab";

const fact = {
  deliveryId: DELIVERY,
  provider: "meta",
  providerMessageId: "wamid.HBgLNTUxMTk5OTk5MDAwMBUCABEYEjk",
  status: "delivered",
  occurredAt: new Date("2026-11-17T15:29:00.000Z"),
};

describe("receiptIdFor", () => {
  it("gives the same fact the same id, however late the repeat arrives", () => {
    const first = receiptIdFor(fact, NOW);

    expect(receiptIdFor({ ...fact }, new Date(NOW.getTime() + 3_600_000))).toBe(
      first,
    );
    // Meta's second report of the same status may carry another timestamp.
    expect(
      receiptIdFor(
        { ...fact, occurredAt: new Date(fact.occurredAt.getTime() + 5_000) },
        NOW,
      ),
    ).toBe(first);
  });

  it("gives every other fact another id", () => {
    const ids = [
      receiptIdFor(fact, NOW),
      receiptIdFor({ ...fact, status: "read" }, NOW),
      receiptIdFor({ ...fact, providerMessageId: "wamid.other" }, NOW),
      receiptIdFor({ ...fact, provider: "resend" }, NOW),
      // A separator inside the provider's text cannot merge two facts.
      receiptIdFor(
        { ...fact, providerMessageId: `${fact.providerMessageId}","read` },
        NOW,
      ),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("starts a tied receipt with its delivery's millisecond", () => {
    const id = receiptIdFor(fact, NOW);

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuid7Instant(id)).toBe(uuid7Instant(DELIVERY));
  });

  it("starts an untied receipt at midnight of the day it happened", () => {
    const untied = { ...fact, deliveryId: null };

    expect(receiptAnchorMs(untied, NOW)).toBe(MIDNIGHT);
    expect(
      receiptAnchorMs(
        { ...untied, occurredAt: new Date("2026-11-15T23:59:59.999Z") },
        NOW,
      ),
    ).toBe(MIDNIGHT - 2 * DAY_MS);
    expect(uuid7Instant(receiptIdFor(untied, NOW))).toBe(MIDNIGHT);
  });

  it("holds an untied receipt's day inside the retention", () => {
    const untied = { ...fact, deliveryId: null };
    const oldest = MIDNIGHT - (UNTIED_RECEIPT_RETENTION_DAYS - 1) * DAY_MS;

    // A report about a message of two months ago: its day is gone.
    expect(
      receiptAnchorMs(
        { ...untied, occurredAt: new Date(NOW.getTime() - 60 * DAY_MS) },
        NOW,
      ),
    ).toBe(oldest);
    // A provider clock a day ahead of ours: that day does not exist yet.
    expect(
      receiptAnchorMs(
        { ...untied, occurredAt: new Date(NOW.getTime() + DAY_MS) },
        NOW,
      ),
    ).toBe(MIDNIGHT);
    expect(
      receiptAnchorMs({ ...untied, occurredAt: new Date(Number.NaN) }, NOW),
    ).toBe(MIDNIGHT);
  });

  it("treats a delivery id that is not a uuid v7 as untied, for the anchor", () => {
    expect(
      receiptAnchorMs(
        { ...fact, deliveryId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
        NOW,
      ),
    ).toBe(MIDNIGHT);
  });
});
