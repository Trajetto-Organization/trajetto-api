import { describe, expect, it } from "vitest";

import {
  deliveryIdFor,
  eventInstantMs,
} from "@/shared/notifications/delivery-id";
import { uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * The id of a notification_delivery is decided by what the row is
 * (plano-escala F5-03).
 *
 * Wave 10 (F5-06) drops the unique indexes on (event, recipient, channel):
 * the queues become partitioned by day on their id, and a unique index
 * there must contain the id. From then on the only thing that keeps a
 * second expansion of an event — a retry after a crash, a replica that took
 * the event over — from writing every delivery twice is that it computes
 * the same primary keys. And the id must stay a uuid v7 with the event's
 * millisecond, or the row lands in another day's partition, or none.
 */
const EVENT = {
  id: "019a9a2e-5c00-7abc-8def-0123456789ab",
  created_at: new Date("2026-11-17T12:00:00.000Z"),
};

const USER = { userId: "019a9a2e-0000-7000-8000-0000000000a1" };
const OTHER_USER = { userId: "019a9a2e-0000-7000-8000-0000000000a2" };
const EXTERNAL = {
  externalRecipientId: "019a9a2e-0000-7000-8000-0000000000e1",
};

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deliveryIdFor", () => {
  it("gives the same id to the same event, recipient and channel, every time", () => {
    const first = deliveryIdFor(EVENT, USER, "IN_APP");

    expect(deliveryIdFor({ ...EVENT }, { ...USER }, "IN_APP")).toBe(first);
    expect(
      deliveryIdFor(
        { id: EVENT.id, created_at: EVENT.created_at.toISOString() },
        { userId: USER.userId, externalRecipientId: null },
        "IN_APP",
      ),
    ).toBe(first);
  });

  it("gives a different id to every other row of the same event", () => {
    const ids = [
      deliveryIdFor(EVENT, USER, "IN_APP"),
      deliveryIdFor(EVENT, USER, "EMAIL"),
      deliveryIdFor(EVENT, USER, "WHATSAPP"),
      deliveryIdFor(EVENT, USER, "PUSH"),
      deliveryIdFor(EVENT, USER, "ACTIVITY"),
      deliveryIdFor(EVENT, OTHER_USER, "IN_APP"),
      deliveryIdFor(EVENT, EXTERNAL, "EMAIL"),
      deliveryIdFor(EVENT, EXTERNAL, "WHATSAPP"),
      // The same id as a user and as an external recipient: two rows.
      deliveryIdFor(EVENT, { externalRecipientId: OTHER_USER.userId }, "EMAIL"),
      deliveryIdFor(EVENT, OTHER_USER, "EMAIL"),
      // Another event of the same millisecond.
      deliveryIdFor(
        { ...EVENT, id: "019a9a2e-5c00-7abc-8def-0123456789ac" },
        USER,
        "IN_APP",
      ),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is a uuid v7 that starts with the event's own millisecond", () => {
    const id = deliveryIdFor(EVENT, USER, "IN_APP");

    expect(id).toMatch(UUID_V7);
    expect(uuid7Instant(id)).toBe(uuid7Instant(EVENT.id));
    expect(id.slice(0, 13)).toBe(EVENT.id.slice(0, 13));
  });

  it("falls back to created_at for an event id that is not a uuid v7", () => {
    // A v4 id starts with random bits: read as a time, it would put the
    // row anywhere between 1970 and the year 10889.
    const legacy = {
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      created_at: EVENT.created_at,
    };

    expect(eventInstantMs(legacy)).toBe(EVENT.created_at.getTime());
    expect(uuid7Instant(deliveryIdFor(legacy, USER, "PUSH"))).toBe(
      EVENT.created_at.getTime(),
    );
    expect(deliveryIdFor(legacy, USER, "PUSH")).toMatch(UUID_V7);
  });

  it("refuses a row with no recipient or with both kinds", () => {
    expect(() => deliveryIdFor(EVENT, {}, "IN_APP")).toThrow(
      /exactly one recipient/,
    );
    expect(() =>
      deliveryIdFor(EVENT, { ...USER, ...EXTERNAL }, "EMAIL"),
    ).toThrow(/exactly one recipient/);
  });
});
