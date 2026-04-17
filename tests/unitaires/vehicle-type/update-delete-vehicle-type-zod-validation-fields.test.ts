import { describe, it, expect } from "vitest";
import { updateDeleteVehicleTypeSchema } from "@/schemas/update-delete-vehicle-type-schema";

describe("Update Delete Vehicle Type Zod Validation Fields", () => {
  it("should validate a valid vehicle type ID", () => {
    const payload = {
      vehicleTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.vehicleTypeId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("should validate a different valid UUID format", () => {
    const payload = {
      vehicleTypeId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.vehicleTypeId).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("should validate another valid UUID format", () => {
    const payload = {
      vehicleTypeId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if vehicleTypeId is missing", () => {
    const payload = {};
    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if vehicleTypeId is empty string", () => {
    const payload = {
      vehicleTypeId: "",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toContain(
      "ID do tipo de veículo é inválido.",
    );
  });

  it("should fail if vehicleTypeId is null", () => {
    const payload = {
      vehicleTypeId: null,
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if vehicleTypeId is undefined", () => {
    const payload = {
      vehicleTypeId: undefined,
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should accept vehicleTypeId with uppercase letters (UUID accepts both cases)", () => {
    const payload = {
      vehicleTypeId: "550E8400-E29B-41D4-A716-446655440000",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.vehicleTypeId).toBe(
      "550E8400-E29B-41D4-A716-446655440000",
    );
  });

  it("should fail if vehicleTypeId is number instead of string", () => {
    const payload = {
      vehicleTypeId: 123456789,
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if vehicleTypeId is boolean", () => {
    const payload = {
      vehicleTypeId: true,
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if vehicleTypeId is array", () => {
    const payload = {
      vehicleTypeId: ["550e8400-e29b-41d4-a716-446655440000"],
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if vehicleTypeId is object", () => {
    const payload = {
      vehicleTypeId: { id: "550e8400-e29b-41d4-a716-446655440000" },
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().vehicleTypeId?._errors).toBeDefined();
  });

  it("should fail if payload contains extra fields", () => {
    const payload = {
      vehicleTypeId: "550e8400-e29b-41d4-a716-446655440000",
      extraField: "should not be here",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);

    // This should still pass because the schema only validates the vehicleTypeId field
    expect(result.success).toBe(true);
    expect(result.data?.vehicleTypeId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("should validate UUID with all different hex characters", () => {
    const payload = {
      vehicleTypeId: "0123456f-89ab-cdef-0123-456789abcdef",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate minimum valid UUID", () => {
    const payload = {
      vehicleTypeId: "00000000-0000-0000-0000-000000000000",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate maximum valid UUID", () => {
    const payload = {
      vehicleTypeId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate mixed case UUID format", () => {
    const payload = {
      vehicleTypeId: "550e8400-E29B-41d4-A716-446655440000",
    };

    const result = updateDeleteVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate realistic vehicle type IDs", () => {
    const validVehicleTypeIds = [
      "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      "12345678-9abc-def0-1234-56789abcdef0",
      "fedcba98-7654-3210-fedc-ba9876543210",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "11111111-2222-3333-4444-555555555555",
    ];

    validVehicleTypeIds.forEach((vehicleTypeId) => {
      const payload = { vehicleTypeId };
      const result = updateDeleteVehicleTypeSchema.safeParse(payload);

      expect(result.success).toBe(true);
      expect(result.data?.vehicleTypeId).toBe(vehicleTypeId);
    });
  });
});
