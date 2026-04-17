import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

describe("Update Delete Branch Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const parsed = updateDeleteBranchSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject invalid businessId format", () => {
    const invalidData = {
      businessId: "invalid-uuid",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da empresa é inválido.",
    );
  });

  it("should reject invalid branchId format", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "invalid-uuid",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da filial é inválido.",
    );
  });

  it("should reject missing businessId", () => {
    const invalidData = {
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject missing branchId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject empty businessId", () => {
    const invalidData = {
      businessId: "",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da empresa é inválido.",
    );
  });

  it("should reject empty branchId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da filial é inválido.",
    );
  });

  it("should reject null businessId", () => {
    const invalidData = {
      businessId: null,
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject null branchId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: null,
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject undefined businessId", () => {
    const invalidData = {
      businessId: undefined,
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject undefined branchId", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: undefined,
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject businessId with wrong format (not UUID)", () => {
    const invalidData = {
      businessId: "12345",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da empresa é inválido.",
    );
  });

  it("should reject branchId with wrong format (not UUID)", () => {
    const invalidData = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "12345",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(
      "ID da filial é inválido.",
    );
  });

  it("should accept valid UUID v4 format", () => {
    const validData = {
      businessId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      branchId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    };

    const parsed = updateDeleteBranchSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept valid UUID v1 format", () => {
    const validData = {
      businessId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      branchId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const parsed = updateDeleteBranchSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should reject both IDs with invalid format", () => {
    const invalidData = {
      businessId: "not-a-uuid",
      branchId: "also-not-a-uuid",
    };

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);

    try {
      updateDeleteBranchSchema.parse(invalidData);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues;
        expect(issues).toHaveLength(2);
        expect(
          issues.some((issue) => issue.message === "ID da empresa é inválido."),
        ).toBe(true);
        expect(
          issues.some((issue) => issue.message === "ID da filial é inválido."),
        ).toBe(true);
      }
    }
  });

  it("should reject empty object", () => {
    const invalidData = {};

    expect(() => updateDeleteBranchSchema.parse(invalidData)).toThrow(ZodError);
  });

  it("should reject additional properties being allowed", () => {
    const dataWithExtra = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
      extraField: "should be ignored or cause error based on schema config",
    };

    // This test depends on schema configuration
    // If the schema is strict, it should reject extra properties
    // If not, it should allow them but only return the defined fields
    const parsed = updateDeleteBranchSchema.parse(dataWithExtra);
    expect(parsed).toEqual({
      businessId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: "550e8400-e29b-41d4-a716-446655440001",
    });
  });
});
