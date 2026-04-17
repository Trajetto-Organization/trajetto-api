import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

describe("Update Delete Vehicle Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      vehicleId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = updateDeleteVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject missing vehicleId", () => {
    const invalidData = {};

    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      ZodError,
    );
  });

  it("should reject empty vehicleId", () => {
    const invalidData = {
      vehicleId: "",
    };

    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      ZodError,
    );
    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      "ID do veículo é inválido.",
    );
  });

  it("should reject null vehicleId", () => {
    const invalidData = {
      vehicleId: null,
    };

    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      ZodError,
    );
  });

  it("should reject undefined vehicleId", () => {
    const invalidData = {
      vehicleId: undefined,
    };

    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      ZodError,
    );
  });

  it("should accept valid UUID v4 format", () => {
    const validData = {
      vehicleId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const parsed = updateDeleteVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept valid UUID v1 format", () => {
    const validData = {
      vehicleId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    };

    const parsed = updateDeleteVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject additional properties being allowed", () => {
    const dataWithExtra = {
      vehicleId: "550e8400-e29b-41d4-a716-446655440000",
      extraField: "should be ignored or cause error based on schema config",
    };

    const parsed = updateDeleteVehicleSchema.parse(dataWithExtra);
    expect(parsed).toEqual({
      vehicleId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("should reject empty object", () => {
    const invalidData = {};

    expect(() => updateDeleteVehicleSchema.parse(invalidData)).toThrow(
      ZodError,
    );
  });
});
