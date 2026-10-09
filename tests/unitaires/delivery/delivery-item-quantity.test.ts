import { describe, expect, it } from "vitest";

import { deliveryItemSchema } from "@/schemas/create-delivery-schema";

/**
 * An item's quantity is stored in numeric(10, 3). `.positive()` accepted
 * 0.0004, which the column rounds to 0.000: an item with quantity zero was
 * saved against the rule "A quantidade deve ser maior que zero". The rule is
 * judged on the value the column will hold (half up at 3 decimals, after
 * reading a float at 15 significant digits, as Postgres does).
 */
const item = (quantity: unknown) =>
  deliveryItemSchema.safeParse({ description: "Caixa", quantity });

describe("a delivery item's quantity", () => {
  it.each([0.0004, 0.00049, "0.0004", 0, -1])(
    "refuses %j, which the column would store as zero or less",
    (quantity) => {
      const parsed = item(quantity);

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        "A quantidade deve ser maior que zero.",
      );
    },
  );

  it.each([
    [0.0005, 0.0005],
    [0.001, 0.001],
    [1.5, 1.5],
    ["2", 2],
  ])("accepts %j, which the column keeps above zero", (quantity, expected) => {
    const parsed = item(quantity);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.quantity).toBe(expected);
  });

  it("still defaults to 1 when absent", () => {
    const parsed = deliveryItemSchema.safeParse({ description: "Caixa" });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.quantity).toBe(1);
  });
});
