import { describe, expect, it } from "vitest";

import { createShipperSchema } from "@/schemas/create-shipper-schema";
import { updateShipperSchema } from "@/schemas/update-shipper-schema";

/**
 * "Razão social" of a shipper (decision 14.8): optional, printed on the
 * proof document as the issuer's legal name. An empty field means none.
 */
describe("the shipper's legal name", () => {
  it("is optional, trimmed, and empty means none", () => {
    expect(createShipperSchema.parse({ name: "Atacado Sol" }).corporate_reason).toBeUndefined();
    expect(
      createShipperSchema.parse({ name: "Atacado Sol", corporate_reason: "  Atacado Sol Ltda " })
        .corporate_reason,
    ).toBe("Atacado Sol Ltda");
    expect(
      updateShipperSchema.parse({ corporate_reason: "" }).corporate_reason,
    ).toBeNull();
  });

  it("refuses one longer than the column", () => {
    expect(
      createShipperSchema.safeParse({ name: "Atacado Sol", corporate_reason: "x".repeat(151) })
        .success,
    ).toBe(false);
  });
});
