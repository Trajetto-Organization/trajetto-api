import { describe, expect, it } from "vitest";

import { deliveryProofSchema } from "@/schemas/delivery-proof-schema";
import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";

/**
 * A phone without a location fix sends `latitude: null` (or ""). `z.coerce`
 * alone turned that into 0, so the occurrence or the proof was recorded at
 * 0,0, a point in the Atlantic, on the tower map, the timeline and the PDF.
 * "No fix" must stay "no position", as the pause and "a caminho" schemas do.
 */
const OCCURRENCE = { occurrenceTypeId: "018f0000-0000-7000-8000-0000000000c1" };
const PROOF = {
  client_submission_id: "018f0000-0000-7000-8000-0000000000d1",
  photo: "business/b1/delivery-proof/photo.jpg",
};

const schemas = [
  ["occurrence report", reportDeliveryOccurrenceSchema, OCCURRENCE],
  ["delivery proof", deliveryProofSchema, PROOF],
] as const;

describe.each(schemas)("the %s coordinates", (_name, schema, base) => {
  it.each([null, ""])("reads %j as no position, not 0", (empty) => {
    const parsed = schema.safeParse({ ...base, latitude: empty, longitude: empty });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.latitude).toBeUndefined();
    expect(parsed.data.longitude).toBeUndefined();
  });

  it("still coerces a numeric string from a form body", () => {
    const parsed = schema.safeParse({ ...base, latitude: "-23.5", longitude: "-46.6" });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.latitude).toBe(-23.5);
    expect(parsed.data.longitude).toBe(-46.6);
  });

  it("keeps a real 0 (the equator is a place)", () => {
    const parsed = schema.safeParse({ ...base, latitude: 0, longitude: 0 });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.latitude).toBe(0);
    expect(parsed.data.longitude).toBe(0);
  });

  it("still refuses a value out of range", () => {
    expect(schema.safeParse({ ...base, latitude: 91 }).success).toBe(false);
    expect(schema.safeParse({ ...base, longitude: -181 }).success).toBe(false);
  });

  it("leaves an absent pair absent", () => {
    const parsed = schema.safeParse(base);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.latitude).toBeUndefined();
  });
});
