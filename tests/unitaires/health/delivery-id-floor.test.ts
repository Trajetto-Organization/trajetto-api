import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deliveryIdFloor } from "@/shared/health/metrics-queries";

/**
 * The 24 h window of /health/metrics is a range of notification_delivery's
 * primary key (OBS-09, PG-18): a uuid v7 starts with the millisecond it was
 * minted, so "ids from this floor up" is "created from this instant on" —
 * read through the pkey, which stays ordered however the heap is reused. The
 * BRIN it replaced widened with every row written into an old page and ended
 * up matching the whole table.
 */
const mintedAt = (ms: number, tail = "7abc-8def-0123456789ab") => {
  const hex = ms.toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${tail}`;
};

describe("deliveryIdFloor", () => {
  const since = new Date("2026-09-23T12:00:00.000Z");
  const floor = deliveryIdFloor(since);

  it("sorts below every uuid v7 minted at or after the instant", () => {
    expect(mintedAt(since.getTime()) >= floor).toBe(true);
    expect(mintedAt(since.getTime(), "7000-8000-000000000000") >= floor).toBe(
      true,
    );
    expect(mintedAt(since.getTime() + 60_000) >= floor).toBe(true);
  });

  it("and above every one minted before it", () => {
    expect(
      mintedAt(since.getTime() - 1, "7fff-bfff-ffffffffffff") >= floor,
    ).toBe(false);
    expect(mintedAt(since.getTime() - 25 * 60 * 60 * 1000) >= floor).toBe(
      false,
    );
  });

  it("is only as right as the delivery ids being uuid v7", () => {
    // A different id default would make the window count silently wrong.
    const schema = readFileSync(
      resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );

    const model = schema.slice(schema.indexOf("model NotificationDelivery {"));

    expect(model).toMatch(/^\s*id\s+String\s+@id\s+@default\(uuid\(7\)\)/m);
  });
});
