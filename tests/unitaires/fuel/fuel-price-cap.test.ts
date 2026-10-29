import { describe, expect, it } from "vitest";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { updateFuelSchema } from "@/schemas/update-fuel-schema";

/**
 * The price per litre (decision 15.9): more than zero and at most R$ 50,00,
 * mirrored by the web and the app. The ceiling was R$ 999,99, and a driver
 * who typed "599" for R$ 5,99 had R$ 599/L saved.
 */
const priceIssues = (
  schema: typeof createFuelSchema | typeof updateFuelSchema,
  price: unknown,
) => {
  const result = schema.safeParse({ price_per_liter: price });

  return result.success
    ? []
    : result.error.issues
        .filter((issue) => issue.path[0] === "price_per_liter")
        .map((issue) => issue.message);
};

describe.each([
  ["create", createFuelSchema],
  ["update", updateFuelSchema],
] as const)("%s fuel schema: price_per_liter", (_name, schema) => {
  it("accepts a pump price up to R$ 50,00", () => {
    expect(priceIssues(schema, 5.899)).toEqual([]);
    expect(priceIssues(schema, "50")).toEqual([]);
  });

  it("refuses anything above R$ 50,00", () => {
    expect(priceIssues(schema, 50.001)).toEqual([
      "O preço por litro não pode exceder R$ 50,00.",
    ]);
    expect(priceIssues(schema, "599")).toEqual([
      "O preço por litro não pode exceder R$ 50,00.",
    ]);
  });

  it("refuses zero and negatives", () => {
    expect(priceIssues(schema, 0).length).toBeGreaterThan(0);
    expect(priceIssues(schema, -2).length).toBeGreaterThan(0);
  });
});
