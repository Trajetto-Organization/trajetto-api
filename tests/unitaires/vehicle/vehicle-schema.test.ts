import { describe, expect, it } from "vitest";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";
import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

/**
 * One vehicle schema for create and update (FLEET-VEH-2).
 *
 * The two used to drift: create took one axle and update demanded two, so a
 * vehicle registered with one axle could never be saved again (the form
 * resends every field); update took 1.5 months against an Int column (a 500
 * from Prisma); km/l was an integer although a truck does 2,5 km/l (decision
 * 8.6); the plate was stored in whatever case it was typed, against a
 * case-sensitive unique index.
 */

const THIS_YEAR = new Date().getUTCFullYear();

const valid = {
  description: "Caminhão baú",
  license_plate: "ABC1D23",
  brand: "Volvo",
  model: "FH 540",
  acquisition_date: "2024-03-10",
  fleet_type: "OWNED",
  current_mileage: 1000,
  maintenance_interval_km: 10000,
  maintenance_interval_months: 6,
  renavam: "12345678901",
  manufacturing_year: `${THIS_YEAR}-01-01`,
  model_year: `${THIS_YEAR + 1}-01-01`,
  km_per_liter: 2.5,
  number_of_axles: 1,
  status: "ACTIVE",
  fuelTypeId: "018f0000-0000-7000-8000-0000000000f1",
};

function issuesOf(
  result: {
    success: boolean;
    error?: { issues: Array<{ path: (string | number)[]; message: string }> };
  },
  field: string,
) {
  return result.success
    ? []
    : (result.error?.issues ?? []).filter((issue) => issue.path[0] === field);
}

describe("the update schema is the create schema made partial", () => {
  it("accepts editing a one-axle vehicle", () => {
    // Red before: update demanded at least two axles.
    expect(updateVehicleSchema.safeParse({ number_of_axles: 1 }).success).toBe(
      true,
    );
  });

  it("refuses fractional months on update, like on create", () => {
    // Red before: update accepted 1.5 and Prisma refused it with a 500.
    expect(
      issuesOf(
        updateVehicleSchema.safeParse({ maintenance_interval_months: 1.5 }),
        "maintenance_interval_months",
      ),
    ).toHaveLength(1);
  });

  it("still parses a single changed field without the others", () => {
    const parsed = updateVehicleSchema.parse({ description: "Truck novo" });

    expect(parsed).toEqual({ description: "Truck novo" });
  });

  it("checks model against manufacturing year when both are sent", () => {
    expect(
      issuesOf(
        updateVehicleSchema.safeParse({
          manufacturing_year: "2020-01-01",
          model_year: "2022-01-01",
        }),
        "model_year",
      ),
    ).toHaveLength(1);
  });
});

describe("the registration", () => {
  it("accepts the full valid payload, with a 2026/2027 truck and 2,5 km/l", () => {
    // Red before: km/l had to be an integer.
    expect(createVehicleSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts km/l with two decimals and refuses three", () => {
    expect(
      createVehicleSchema.safeParse({ ...valid, km_per_liter: 3.75 }).success,
    ).toBe(true);
    expect(
      issuesOf(
        createVehicleSchema.safeParse({ ...valid, km_per_liter: 3.755 }),
        "km_per_liter",
      ),
    ).toHaveLength(1);
  });

  it("stores the plate in capitals", () => {
    // Red before: "abc1d23" reached the case-sensitive unique index as typed.
    expect(
      createVehicleSchema.parse({ ...valid, license_plate: "abc1d23" })
        .license_plate,
    ).toBe("ABC1D23");
  });

  it("refuses a fleet identifier longer than 50 characters", () => {
    // Red before: no ceiling at all.
    expect(
      issuesOf(
        createVehicleSchema.safeParse({ ...valid, fleet_id: "x".repeat(51) }),
        "fleet_id",
      ),
    ).toHaveLength(1);
    expect(
      createVehicleSchema.safeParse({ ...valid, fleet_id: "" }).success,
    ).toBe(true);
  });

  it("refuses a manufacturing year in the future and a model two years ahead", () => {
    expect(
      issuesOf(
        createVehicleSchema.safeParse({
          ...valid,
          manufacturing_year: `${THIS_YEAR + 1}-01-01`,
          model_year: `${THIS_YEAR + 1}-01-01`,
        }),
        "manufacturing_year",
      ),
    ).toHaveLength(1);

    expect(
      issuesOf(
        createVehicleSchema.safeParse({
          ...valid,
          model_year: `${THIS_YEAR + 2}-01-01`,
        }),
        "model_year",
      ).length,
    ).toBeGreaterThan(0);
  });
});
