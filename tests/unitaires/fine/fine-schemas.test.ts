import { describe, expect, it } from "vitest";

import { createFineSchema } from "@/schemas/create-fine-schema";
import { updateFineSchema } from "@/schemas/update-fine-schema";

/**
 * The fine request schemas: what they accept as the person types it, and
 * what they no longer take from the client.
 */
const valid = {
  violation_date: "2026-09-10T03:00:00.000Z",
  due_date: "2026-10-10T03:00:00.000Z",
  amount: "293,47",
  points: "4",
  branchId: "018f0000-0000-7000-8000-0000000001a1",
  driverId: "018f0000-0000-7000-8000-0000000002a1",
  vehicleId: "018f0000-0000-7000-8000-0000000003a1",
  trafficViolationCodeId: "018f0000-0000-7000-8000-0000000004a1",
  created_from: "WEB_DASHBOARD",
};

describe("createFineSchema", () => {
  it.each([
    ["293,47", 293.47],
    ["1.234,56", 1234.56],
    ["293.47", 293.47],
    ["R$ 50", 50],
  ])("reads the amount %s as %d", (amount, expected) => {
    expect(createFineSchema.parse({ ...valid, amount }).amount).toBe(expected);
  });

  it("accepts the address as the notice prints it", () => {
    const parsed = createFineSchema.parse({
      ...valid,
      location: "Av. Brasil, 1000 - Centro/SP",
    });

    expect(parsed.location).toBe("Av. Brasil, 1000 - Centro/SP");
  });

  it("accepts a multiline observation with punctuation", () => {
    const observation = "Radar móvel.\n\nNotificação recebida em 12/09.";

    expect(createFineSchema.parse({ ...valid, observation }).observation).toBe(
      observation,
    );
  });

  it("still refuses repeated spaces and spaces at the ends", () => {
    expect(createFineSchema.safeParse({ ...valid, location: "Av.  Brasil" }).success).toBe(
      false,
    );
    expect(createFineSchema.safeParse({ ...valid, observation: " Radar" }).success).toBe(
      false,
    );
  });

  it("takes zero points and refuses negative ones", () => {
    expect(createFineSchema.parse({ ...valid, points: "0" }).points).toBe(0);
    expect(createFineSchema.safeParse({ ...valid, points: "-1" }).success).toBe(false);
  });

  it("leaves the points out when the client does not send them (the code's apply)", () => {
    const { points: _points, ...withoutPoints } = valid;

    const parsed = createFineSchema.safeParse(withoutPoints);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.points).toBeUndefined();
  });

  it("takes the picked day as the form sends it, and an instant from older clients", () => {
    const parsed = createFineSchema.parse({
      ...valid,
      violation_date: "2026-09-10",
      due_date: "2026-10-10",
      payment_date: "2026-09-12",
    });

    expect(parsed).toMatchObject({
      violation_date: "2026-09-10",
      due_date: "2026-10-10",
      payment_date: "2026-09-12",
    });
    expect(createFineSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a day that does not exist instead of rolling it over", () => {
    // new Date("2026-02-30") is 2 March: it used to pass as a date.
    for (const field of ["violation_date", "due_date", "payment_date"]) {
      expect(
        createFineSchema.safeParse({ ...valid, [field]: "2026-02-30" }).success,
      ).toBe(false);
    }
  });
});

describe("updateFineSchema", () => {
  it("drops the location audit a client sends", () => {
    const parsed = updateFineSchema.parse({
      amount: "10",
      location_edited_by: "018f0000-0000-7000-8000-0000000009a9",
      location_edited_at: "2026-09-10T10:00:00.000Z",
      location_source: "GPS_AUTO",
      latitude_original: -10,
      longitude_original: -40,
    }) as Record<string, unknown>;

    expect(parsed).toEqual({ amount: 10 });
  });

  it("reads an empty payment date as undoing the payment", () => {
    expect(updateFineSchema.parse({ payment_date: "" }).payment_date).toBeNull();
  });

  it("takes days and refuses one that does not exist", () => {
    expect(updateFineSchema.parse({ due_date: "2026-10-10" }).due_date).toBe("2026-10-10");
    expect(updateFineSchema.safeParse({ due_date: "2026-04-31" }).success).toBe(false);
  });
});
