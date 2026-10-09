import { describe, expect, it } from "vitest";

import type { CreateShipperProps } from "@/modules/shipper/dtos/shipper-dto";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";

/**
 * The twin writes a new shipper as Postgres does (decision 13.2): a column
 * the caller left undefined keeps its default. Prisma omits an undefined key
 * from the INSERT, so corporate_reason (20261005120300) is stored as NULL.
 */
describe("InMemoryShipperRepository column defaults", () => {
  it("keeps corporate_reason null when the caller passes it undefined", async () => {
    const repo = new InMemoryShipperRepository();

    const shipper = await repo.createShipper({
      name: "Embarcador Sol",
      businessId: "018fe1a0-0000-7000-8000-000000000001",
      corporate_reason: undefined,
    } as CreateShipperProps);

    expect(shipper).toHaveProperty("corporate_reason", null);
  });
});
