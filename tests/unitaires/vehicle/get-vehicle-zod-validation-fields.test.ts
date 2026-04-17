import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { getVehicleSchema } from "@/schemas/get-vehicle-schema";

describe("Get Vehicle Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject missing businessId", () => {
    const invalidData = {
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "ID da empresa é obrigatório!",
    );
  });

  it("should reject missing vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "ID do veículo é obrigatório!",
    );
  });

  it("should reject empty businessId", () => {
    const invalidData = {
      businessId: "",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "ID da empresa é inválido.",
    );
  });

  it("should reject empty vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: "",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "ID do veículo é inválido.",
    );
  });

  it("should reject null businessId", () => {
    const invalidData = {
      businessId: null,
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject null vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: null,
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject undefined businessId", () => {
    const invalidData = {
      businessId: undefined,
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject undefined vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: undefined,
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should accept valid UUID v4 format", () => {
    const validData = {
      businessId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      vehicleId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept valid UUID v1 format", () => {
    const validData = {
      businessId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      vehicleId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept any non-empty strings (schema doesn't enforce UUID)", () => {
    const validData = {
      businessId: "550e8400-e29b-41d4-a716-446655440001",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject both IDs with empty strings", () => {
    const invalidData = {
      businessId: "",
      vehicleId: "",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);

    try {
      getVehicleSchema.parse(invalidData);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues;

        expect(issues).toHaveLength(2);
        expect(
          issues.some((issue) => issue.message === "ID da empresa é inválido."),
        ).toBe(true);

        expect(
          issues.some((issue) => issue.message === "ID do veículo é inválido."),
        ).toBe(true);
      }
    }
  });

  it("should reject empty object", () => {
    const invalidData = {};
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should accept IDs with numbers only", () => {
    const validData = {
      businessId: "550e8400-e29b-41d4-a716-446655440001",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });
});
