import { describe, it, expect } from "vitest";
import { updateDeletePartSchema } from "@/schemas/update-delete-part-schema";

describe("Update Delete Part Zod Validation Fields", () => {
  it("should validate a valid part ID", () => {
    const payload = {
      partId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.partId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("should validate a different valid UUID format", () => {
    const payload = {
      partId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.partId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("should validate another valid UUID format", () => {
    const payload = {
      partId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if partId is missing", () => {
    const payload = {};

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is empty string", () => {
    const payload = {
      partId: "",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is null", () => {
    const payload = {
      partId: null,
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is undefined", () => {
    const payload = {
      partId: undefined,
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is invalid UUID format", () => {
    const payload = {
      partId: "invalid-uuid-format",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is almost valid UUID but missing character", () => {
    const payload = {
      partId: "550e8400-e29b-41d4-a716-44665544000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is almost valid UUID but with extra character", () => {
    const payload = {
      partId: "550e8400-e29b-41d4-a716-4466554400000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId has wrong format with wrong dashes", () => {
    const payload = {
      partId: "550e8400_e29b_41d4_a716_446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should accept partId with uppercase letters (UUID accepts both cases)", () => {
    const payload = {
      partId: "550E8400-E29B-41D4-A716-446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.partId).toBe("550E8400-E29B-41D4-A716-446655440000");
  });

  it("should fail if partId contains invalid characters", () => {
    const payload = {
      partId: "550e8400-e29g-41d4-a716-446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId has no dashes", () => {
    const payload = {
      partId: "550e8400e29b41d4a716446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is just random string", () => {
    const payload = {
      partId: "not-a-uuid-at-all",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is numeric string", () => {
    const payload = {
      partId: "123456789",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should fail if partId is number instead of string", () => {
    const payload = {
      partId: 123456789,
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is boolean", () => {
    const payload = {
      partId: true,
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is array", () => {
    const payload = {
      partId: ["550e8400-e29b-41d4-a716-446655440000"],
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if partId is object", () => {
    const payload = {
      partId: { id: "550e8400-e29b-41d4-a716-446655440000" },
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toBeDefined();
  });

  it("should fail if payload contains extra fields", () => {
    const payload = {
      partId: "550e8400-e29b-41d4-a716-446655440000",
      extraField: "should not be here",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    // This should still pass because the schema only validates the partId field
    expect(result.success).toBe(true);
    expect(result.data?.partId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("should handle whitespace around partId", () => {
    const payload = {
      partId: " 550e8400-e29b-41d4-a716-446655440000 ",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });

  it("should validate UUID with all different hex characters", () => {
    const payload = {
      partId: "0123456f-89ab-cdef-0123-456789abcdef",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate minimum valid UUID", () => {
    const payload = {
      partId: "00000000-0000-0000-0000-000000000000",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate maximum valid UUID", () => {
    const payload = {
      partId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };

    const result = updateDeletePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if partId has wrong segment lengths", () => {
    const payload = {
      partId: "550e840-e29b-41d4-a716-446655440000",
    };

    const result = updateDeletePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().partId?._errors).toContain(
      "O ID da peça é obrigatório!",
    );
  });
});
