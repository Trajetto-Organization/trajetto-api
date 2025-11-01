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
      "A empresa é obrigatória!",
    );
  });

  it("should reject missing vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "O veículo é obrigatório!",
    );
  });

  it("should reject empty businessId", () => {
    const invalidData = {
      businessId: "",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "A empresa é obrigatória!",
    );
  });

  it("should reject empty vehicleId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: "",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => getVehicleSchema.parse(invalidData)).toThrow(
      "O veículo é obrigatório!",
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
      businessId: "some-business-id-123",
      vehicleId: "some-vehicle-id-456",
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
          issues.some((issue) => issue.message === "A empresa é obrigatória!"),
        ).toBe(true);
        expect(
          issues.some((issue) => issue.message === "O veículo é obrigatório!"),
        ).toBe(true);
      }
    }
  });

  it("should reject empty object", () => {
    const invalidData = {};

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject additional properties being allowed", () => {
    const dataWithExtra = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
      extraField: "should be ignored or cause error based on schema config",
    };

    const parsed = getVehicleSchema.parse(dataWithExtra);
    expect(parsed).toEqual({
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    });
  });

  it("should reject businessId as number", () => {
    const invalidData = {
      businessId: 123456,
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject vehicleId as number", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: 123456,
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject businessId as boolean", () => {
    const invalidData = {
      businessId: true,
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject vehicleId as boolean", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: false,
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject businessId as array", () => {
    const invalidData = {
      businessId: ["550e8400-e29b-41d4-a716-446655440000"],
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject vehicleId as array", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: ["550e8400-e29b-41d4-a716-446655440001"],
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject businessId as object", () => {
    const invalidData = {
      businessId: { id: "550e8400-e29b-41d4-a716-446655440000" },
      vehicleId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject vehicleId as object", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      vehicleId: { id: "550e8400-e29b-41d4-a716-446655440001" },
    };

    expect(() => getVehicleSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should accept IDs with special characters", () => {
    const validData = {
      businessId: "business-id-with-special-chars_123",
      vehicleId: "vehicle-id-with-special-chars_456",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept IDs with numbers only", () => {
    const validData = {
      businessId: "123456789",
      vehicleId: "987654321",
    };

    const parsed = getVehicleSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });
});
