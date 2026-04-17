import { describe, it, expect } from "vitest";
import { updatePartSchema } from "@/schemas/update-part-schema";

describe("Update Part Zod Validation Fields", () => {
  it("should validate a valid complete part update payload", () => {
    const payload = {
      description: "Filtro de ar condicionado atualizado",
      unit_price: 55.99,
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
      businessId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid partial part update payload", () => {
    const payload = {
      description: "Filtro atualizado",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only unit_price", () => {
    const payload = {
      unit_price: 99.99,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only supplierId", () => {
    const payload = {
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only businessId", () => {
    const payload = {
      businessId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate empty payload", () => {
    const payload = {};

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Description validation tests
  it("should fail if the description is too short", () => {
    const payload = {
      description: "AB",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description exceeds 100 characters", () => {
    const payload = {
      description: "a".repeat(101),
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the description contains consecutive spaces", () => {
    const payload = {
      description: "Filtro  de  ar  atualizado",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the description has spaces at edges", () => {
    const payload = {
      description: " Filtro de ar atualizado ",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at beginning only", () => {
    const payload = {
      description: " Filtro de ar atualizado",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at end only", () => {
    const payload = {
      description: "Filtro de ar atualizado ",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description starts with symbol", () => {
    const payload = {
      description: "@Filtro de ar atualizado",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should fail if the description ends with symbol", () => {
    const payload = {
      description: "Filtro de ar atualizado@",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept valid description with symbols in the middle", () => {
    const payload = {
      description: "Filtro@2024_v2.0-premium",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description with accented characters", () => {
    const payload = {
      description: "Peça de reposição atualizada",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description starting and ending with numbers", () => {
    const payload = {
      description: "123 Filtro especial atualizado 456",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 100 characters", () => {
    const payload = {
      description: "a".repeat(100),
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 3 characters", () => {
    const payload = {
      description: "XYZ",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Unit price validation tests
  it("should fail if unit_price is zero", () => {
    const payload = {
      unit_price: 0,
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário deve ser um valor positivo.",
    );
  });

  it("should fail if unit_price is negative", () => {
    const payload = {
      unit_price: -15.5,
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário deve ser um valor positivo.",
    );
  });

  it("should fail if unit_price exceeds maximum value", () => {
    const payload = {
      unit_price: 1000000.0,
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário não pode exceder 999.999,99.",
    );
  });

  it("should accept valid unit_price at maximum boundary", () => {
    const payload = {
      unit_price: 999999.99,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid unit_price with decimal places", () => {
    const payload = {
      unit_price: 199.95,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept very small positive unit_price", () => {
    const payload = {
      unit_price: 0.01,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept integer unit_price", () => {
    const payload = {
      unit_price: 75,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Supplier ID validation tests
  it("should fail if supplierId is invalid UUID", () => {
    const payload = {
      supplierId: "invalid-uuid-string",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().supplierId?._errors).toContain(
      "ID do fornecedor é inválido.",
    );
  });

  it("should accept null supplierId", () => {
    const payload = {
      supplierId: null,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid UUID supplierId", () => {
    const payload = {
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.supplierId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("should accept valid UUID supplierId with different format", () => {
    const payload = {
      supplierId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if supplierId is empty string", () => {
    const payload = {
      supplierId: "",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().supplierId?._errors).toContain(
      "ID do fornecedor é inválido.",
    );
  });

  // Business ID validation tests
  it("should fail if businessId is invalid UUID", () => {
    const payload = {
      businessId: "invalid-business-uuid",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "ID da empresa é inválido.",
    );
  });

  it("should accept valid UUID businessId", () => {
    const payload = {
      businessId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.businessId).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("should accept valid UUID businessId with different format", () => {
    const payload = {
      businessId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if businessId is empty string", () => {
    const payload = {
      businessId: "",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().businessId?._errors).toContain(
      "ID da empresa é inválido.",
    );
  });

  // Combined validation tests
  it("should validate multiple fields with valid values", () => {
    const payload = {
      description: "Peça completa atualizada",
      unit_price: 150.75,
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
      businessId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail with multiple invalid fields", () => {
    const payload = {
      description: "AB",
      unit_price: -10.5,
      supplierId: "invalid-uuid",
      businessId: "invalid-business-uuid",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );

    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário deve ser um valor positivo.",
    );
    expect(result.error?.format().supplierId?._errors).toContain(
      "ID do fornecedor é inválido.",
    );

    expect(result.error?.format().businessId?._errors).toContain(
      "ID da empresa é inválido.",
    );
  });

  it("should accept mixed valid and undefined fields", () => {
    const payload = {
      description: "Filtro atualizado",
      unit_price: undefined,
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
      businessId: undefined,
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail for description with only symbols", () => {
    const payload = {
      description: "@#$%&*",
    };

    const result = updatePartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept description with mixed valid characters", () => {
    const payload = {
      description: "A1B2-C3_D4.E5F6",
    };

    const result = updatePartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
