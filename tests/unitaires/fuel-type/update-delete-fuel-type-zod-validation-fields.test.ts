import { describe, it, expect } from "vitest";
import { updateDeleteFuelTypeSchema } from "@/schemas/update-delete-fuel-type-schema";

describe("Update Delete Fuel Type Zod Validation Fields", () => {
  it("should validate a valid fuel type UUID", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.fuelTypeId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("should validate a different valid UUID format", () => {
    const payload = {
      fuelTypeId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.fuelTypeId).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("should validate another valid UUID format", () => {
    const payload = {
      fuelTypeId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate UUID with all different hex characters", () => {
    const payload = {
      fuelTypeId: "0123456f-89ab-cdef-0123-456789abcdef",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate minimum valid UUID", () => {
    const payload = {
      fuelTypeId: "00000000-0000-0000-0000-000000000000",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate maximum valid UUID", () => {
    const payload = {
      fuelTypeId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate mixed case UUID format", () => {
    const payload = {
      fuelTypeId: "550e8400-E29B-41d4-A716-446655440000",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate UUID with uppercase letters", () => {
    const payload = {
      fuelTypeId: "550E8400-E29B-41D4-A716-446655440000",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.fuelTypeId).toBe(
      "550E8400-E29B-41D4-A716-446655440000",
    );
  });

  it("should validate realistic fuel type UUIDs", () => {
    const validFuelTypeIds = [
      "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      "12345678-9abc-def0-1234-56789abcdef0",
      "fedcba98-7654-3210-fedc-ba9876543210",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "11111111-2222-3333-4444-555555555555",
    ];

    validFuelTypeIds.forEach((fuelTypeId) => {
      const payload = { fuelTypeId };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(true);
      expect(result.data?.fuelTypeId).toBe(fuelTypeId);
    });
  });

  it("should validate UUID with all valid hex digits", () => {
    const payload = {
      fuelTypeId: "0123456789abcdef-0123-4567-89ab-cdef01234567",
    };

    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail if fuelTypeId is missing", () => {
    const payload = {};
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail if fuelTypeId is empty string", () => {
    const payload = {
      fuelTypeId: "",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail if fuelTypeId is null", () => {
    const payload = {
      fuelTypeId: null,
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail if fuelTypeId is undefined", () => {
    const payload = {
      fuelTypeId: undefined,
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail for invalid UUID format (missing character)", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b-41d4-a716-44665544000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for invalid UUID format (extra character)", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b-41d4-a716-4466554400000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with underscores instead of dashes", () => {
    const payload = {
      fuelTypeId: "550e8400_e29b_41d4_a716_446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for UUID with invalid hex character", () => {
    const payload = {
      fuelTypeId: "550e8400-e29g-41d4-a716-446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with no dashes", () => {
    const payload = {
      fuelTypeId: "550e8400e29b41d4a716446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for non-UUID random string", () => {
    const payload = {
      fuelTypeId: "not-a-uuid-at-all",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for numeric string", () => {
    const payload = {
      fuelTypeId: "123456789",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail if fuelTypeId is number instead of string", () => {
    const payload = {
      fuelTypeId: 123456789,
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail if fuelTypeId is boolean", () => {
    const payload = {
      fuelTypeId: true,
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail if fuelTypeId is array", () => {
    const payload = {
      fuelTypeId: ["550e8400-e29b-41d4-a716-446655440000"],
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should fail if fuelTypeId is object", () => {
    const payload = {
      fuelTypeId: { id: "550e8400-e29b-41d4-a716-446655440000" },
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toBeDefined();
  });

  it("should handle payload with extra fields", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440000",
      extraField: "should be ignored",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.fuelTypeId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );

    expect(result.data).not.toHaveProperty("extraField");
  });

  it("should fail for string with whitespace around fuelTypeId", () => {
    const payload = {
      fuelTypeId: " 550e8400-e29b-41d4-a716-446655440000 ",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with different segment lengths", () => {
    const payload = {
      fuelTypeId: "550e840-e29b-41d4-a716-446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with invalid hex character 'z'", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b-41d4-a716-446655440z00",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with too many dashes", () => {
    const payload = {
      fuelTypeId: "550e-8400-e29b-41d4-a716-446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with too few dashes", () => {
    const payload = {
      fuelTypeId: "550e8400-e29b41d4-a716-446655440000",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with only spaces", () => {
    const payload = {
      fuelTypeId: "   ",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with tab characters", () => {
    const payload = {
      fuelTypeId: "\t\t\t",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should fail for string with newline characters", () => {
    const payload = {
      fuelTypeId: "\n\n",
    };
    const result = updateDeleteFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().fuelTypeId?._errors).toContain(
      "O ID do tipo de combustível é obrigatório!",
    );
  });

  it("should validate various valid UUID formats", () => {
    const validUUIDs = [
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "12345678-1234-1234-1234-123456789abc",
      "abcdef01-2345-6789-abcd-ef0123456789",
      "deadbeef-cafe-babe-dead-beefcafebabe",
      "f0f0f0f0-0f0f-0f0f-0f0f-f0f0f0f0f0f0",
    ];

    validUUIDs.forEach((uuid) => {
      const payload = { fuelTypeId: uuid };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(true);
      expect(result.data?.fuelTypeId).toBe(uuid);
    });
  });

  it("should fail for various invalid UUID formats", () => {
    const invalidUUIDs = [
      "550e8400e29b41d4a716446655440000", // no dashes
      "550e8400-e29b-41d4-a716", // too short
      "550e8400-e29b-41d4-a716-446655440000-extra", // too long
      "550e8400-e29b-41d4-a716-44665544000g", // invalid character
      "not-a-valid-uuid-at-all-whatsoever", // not a UUID
      "12345678-90ab-cdef-ghij-klmnopqrstuv", // invalid characters
      "550e8400_e29b_41d4_a716_446655440000", // underscores
      "550e8400 e29b 41d4 a716 446655440000", // spaces
      "550e8400.e29b.41d4.a716.446655440000", // periods
    ];

    invalidUUIDs.forEach((invalidUUID) => {
      const payload = { fuelTypeId: invalidUUID };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().fuelTypeId?._errors).toContain(
        "O ID do tipo de combustível é obrigatório!",
      );
    });
  });

  it("should fail for edge case UUID variations", () => {
    const edgeCaseUUIDs = [
      " 550e8400-e29b-41d4-a716-446655440000", // leading space
      "550e8400-e29b-41d4-a716-446655440000 ", // trailing space
      "\t550e8400-e29b-41d4-a716-446655440000", // leading tab
      "550e8400-e29b-41d4-a716-446655440000\n", // trailing newline
      "550e8400-e29b-41d4-a716-44665544000", // missing one character
      "550e8400-e29b-41d4-a716-4466554400000", // extra character
      "550e8400-e29b-41d4-a71-6446655440000", // dash in wrong place
    ];

    edgeCaseUUIDs.forEach((edgeCase) => {
      const payload = { fuelTypeId: edgeCase };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().fuelTypeId?._errors).toContain(
        "O ID do tipo de combustível é obrigatório!",
      );
    });
  });

  it("should maintain strict UUID validation for fuel type operations", () => {
    // This test ensures that fuel type operations require proper UUID format
    // which is more restrictive than the vehicle-type module
    const strictlyValidUUIDs = [
      "550e8400-e29b-41d4-a716-446655440000",
      "123e4567-e89b-12d3-a456-426614174000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
    ];

    strictlyValidUUIDs.forEach((uuid) => {
      const payload = { fuelTypeId: uuid };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(true);
    });

    const strictlyInvalidFormats = [
      "550e8400e29b41d4a716446655440000", // valid hex but no dashes
      "not-a-uuid", // random string
      "123", // short string
      "550e8400-e29b-41d4-a716-44665544000g", // invalid hex character
    ];

    strictlyInvalidFormats.forEach((invalidFormat) => {
      const payload = { fuelTypeId: invalidFormat };
      const result = updateDeleteFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().fuelTypeId?._errors).toContain(
        "O ID do tipo de combustível é obrigatório!",
      );
    });
  });
});
