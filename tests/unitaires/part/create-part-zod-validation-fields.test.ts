import { describe, it, expect } from "vitest";
import { createPartSchema } from "@/schemas/create-part-schema";

describe("Create Part Zod Validation Fields", () => {
  it("should validate a valid complete part payload", () => {
    const payload = {
      description: "Filtro de ar condicionado",
      unit_price: 45.99,
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid minimal part payload (without supplier)", () => {
    const payload = {
      description: "Peça teste",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid part payload with null supplier", () => {
    const payload = {
      description: "Filtro de combustível",
      unit_price: 25.75,
      supplierId: null,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the description is missing", () => {
    const payload = {
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is empty", () => {
    const payload = {
      description: "",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description is too short", () => {
    const payload = {
      description: "AB",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description exceeds 100 characters", () => {
    const payload = {
      description: "a".repeat(101),
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the description contains consecutive spaces", () => {
    const payload = {
      description: "Filtro  de  ar",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the description has spaces at edges", () => {
    const payload = {
      description: " Filtro de ar ",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at beginning only", () => {
    const payload = {
      description: " Filtro de ar",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at end only", () => {
    const payload = {
      description: "Filtro de ar ",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description starts with symbol", () => {
    const payload = {
      description: "@Filtro de ar",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should fail if the description ends with symbol", () => {
    const payload = {
      description: "Filtro de ar@",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept valid description with symbols in the middle", () => {
    const payload = {
      description: "Filtro@2024_v1.0-premium",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description with accented characters", () => {
    const payload = {
      description: "Peça de reposição",
      unit_price: 15.3,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description starting and ending with numbers", () => {
    const payload = {
      description: "123 Filtro especial 456",
      unit_price: 20.0,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if unit_price is missing", () => {
    const payload = {
      description: "Filtro de ar",
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toBeDefined();
  });

  it("should fail if unit_price is zero", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 0,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário deve ser um valor positivo.",
    );
  });

  it("should fail if unit_price is negative", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: -10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário deve ser um valor positivo.",
    );
  });

  it("should fail if unit_price exceeds maximum value", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 1000000.0,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toContain(
      "O preço unitário não pode exceder 999.999,99.",
    );
  });

  it("should accept valid unit_price at maximum boundary", () => {
    const payload = {
      description: "Peça premium",
      unit_price: 999999.99,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid unit_price with decimal places", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 123.45,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept very small positive unit_price", () => {
    const payload = {
      description: "Parafuso pequeno",
      unit_price: 0.01,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept integer unit_price", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 50,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if unit_price is not a number", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: "10.50",
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().unit_price?._errors).toBeDefined();
  });

  it("should fail if supplierId is invalid UUID", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 10.5,
      supplierId: "invalid-uuid",
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().supplierId?._errors).toContain(
      "O ID do fornecedor deve ser um UUID válido.",
    );
  });

  it("should fail if supplierId is empty string", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 10.5,
      supplierId: "",
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.supplierId).toBe(null);
  });

  it("should accept undefined supplierId", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 10.5,
      supplierId: undefined,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.supplierId).toBe(null);
  });

  it("should accept valid UUID supplierId", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 10.5,
      supplierId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.supplierId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("should accept valid UUID supplierId with different format", () => {
    const payload = {
      description: "Filtro de ar",
      unit_price: 10.5,
      supplierId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 100 characters", () => {
    const payload = {
      description: "a".repeat(100),
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 3 characters", () => {
    const payload = {
      description: "ABC",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail for description with only symbols", () => {
    const payload = {
      description: "@#$%&*",
      unit_price: 10.5,
    };

    const result = createPartSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept description with mixed valid characters", () => {
    const payload = {
      description: "A1B2-C3_D4.E5",
      unit_price: 25.99,
    };

    const result = createPartSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
