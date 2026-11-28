import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deliveryIdFloor } from "@/shared/health/metrics-queries";
import { deliveryIdFor } from "@/shared/notifications/delivery-id";

/**
 * The 24 h window of /health/metrics is a range of notification_delivery's
 * primary key (OBS-09, PG-18): a uuid v7 starts with the millisecond it was
 * minted, so "ids from this floor up" is "created from this instant on" —
 * read through the pkey, which stays ordered however the heap is reused. The
 * BRIN it replaced widened with every row written into an old page and ended
 * up matching the whole table.
 *
 * Since plano-escala F5-03 the pipeline writes each delivery under an id
 * decided by its event, recipient and channel, with the EVENT's
 * millisecond in front: the window counts deliveries by when their event
 * was published.
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

  it("counts a delivery by the instant of its event", () => {
    const user = { userId: "019a9000-0000-7000-8000-0000000000a1" };

    const inside = deliveryIdFor(
      { id: mintedAt(since.getTime()), created_at: new Date(0) },
      user,
      "IN_APP",
    );

    const before = deliveryIdFor(
      { id: mintedAt(since.getTime() - 1), created_at: new Date(0) },
      user,
      "IN_APP",
    );

    expect(inside >= floor).toBe(true);
    expect(before >= floor).toBe(false);
  });

  it("is what the pipeline writes every delivery under", () => {
    // A delivery written under another id would fall in a window by
    // chance, or in none.
    const pipeline = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/notifications/notification-pipeline-service.ts",
      ),
      "utf8",
    );

    expect(pipeline).toMatch(/id: deliveryIdFor\(event, row, row\.channel\)/);
    expect(pipeline.match(/notificationDelivery\.create(Many)?\(/g)).toEqual([
      "notificationDelivery.createMany(",
    ]);
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
