import { describe, it, expect } from "vitest";
import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";

describe("Update Vehicle Type Zod Validation Fields", () => {
  it("should validate a valid complete vehicle type update payload", () => {
    const payload = {
      description: "Caminhão 3/4 atualizado",
      number_of_axles: 3,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid partial vehicle type update payload", () => {
    const payload = {
      description: "Carreta atualizada",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only number_of_axles", () => {
    const payload = {
      number_of_axles: 5,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate empty payload", () => {
    const payload = {};

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept empty string description", () => {
    const payload = {
      description: "",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept undefined description", () => {
    const payload = {
      description: undefined,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept undefined number_of_axles", () => {
    const payload = {
      number_of_axles: undefined,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Description validation tests
  it("should fail if the description is too short when provided", () => {
    const payload = {
      description: "AB",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description exceeds 100 characters", () => {
    const payload = {
      description: "a".repeat(101),
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the description contains consecutive spaces", () => {
    const payload = {
      description: "Caminhão  3/4  atualizado",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the description has spaces at edges", () => {
    const payload = {
      description: " Caminhão 3/4 atualizado ",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at beginning only", () => {
    const payload = {
      description: " Caminhão 3/4 atualizado",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at end only", () => {
    const payload = {
      description: "Caminhão 3/4 atualizado ",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description starts with symbol", () => {
    const payload = {
      description: "@Caminhão 3/4 atualizado",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should fail if the description ends with symbol", () => {
    const payload = {
      description: "Caminhão 3/4 atualizado@",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept valid description with symbols in the middle", () => {
    const payload = {
      description: "Caminhão@2024_v2.0-premium",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description with accented characters", () => {
    const payload = {
      description: "Caminhão de carga atualizado",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description starting and ending with numbers", () => {
    const payload = {
      description: "2024 Caminhão atualizado 456",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 100 characters", () => {
    const payload = {
      description: "a".repeat(100),
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 3 characters", () => {
    const payload = {
      description: "Van",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Number of axles validation tests
  it("should fail if number_of_axles is zero when provided", () => {
    const payload = {
      number_of_axles: 0,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should fail if number_of_axles is negative", () => {
    const payload = {
      number_of_axles: -2,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should fail if number_of_axles exceeds maximum value", () => {
    const payload = {
      number_of_axles: 15,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no máximo 10.",
    );
  });

  it("should accept valid number_of_axles at maximum boundary", () => {
    const payload = {
      number_of_axles: 10,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid number_of_axles at minimum boundary", () => {
    const payload = {
      number_of_axles: 1,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if number_of_axles is not an integer", () => {
    const payload = {
      number_of_axles: 3.5,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser um número inteiro.",
    );
  });

  it("should accept valid number_of_axles with decimal places", () => {
    const payload = {
      number_of_axles: 4.0,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept integer number_of_axles", () => {
    const payload = {
      number_of_axles: 6,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if number_of_axles is not a number", () => {
    const payload = {
      number_of_axles: "3",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is null", () => {
    const payload = {
      number_of_axles: null,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is boolean", () => {
    const payload = {
      number_of_axles: true,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is array", () => {
    const payload = {
      number_of_axles: [3],
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is object", () => {
    const payload = {
      number_of_axles: { value: 3 },
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  // Combined validation tests
  it("should validate multiple fields with valid values", () => {
    const payload = {
      description: "Carreta bi-trem atualizada",
      number_of_axles: 7,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail with multiple invalid fields", () => {
    const payload = {
      description: "AB",
      number_of_axles: -1,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should accept mixed valid and undefined fields", () => {
    const payload = {
      description: "Caminhão atualizado",
      number_of_axles: undefined,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail for description with only symbols", () => {
    const payload = {
      description: "@#$%&*",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept description with mixed valid characters", () => {
    const payload = {
      description: "A1B2-C3_D4.E5F6",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept common updated vehicle type descriptions", () => {
    const validUpdates = [
      { description: "Carro atualizado" },
      { description: "Moto modelo novo" },
      { description: "Caminhão 3/4 revisado" },
      { description: "Carreta modernizada" },
      { number_of_axles: 2 },
      { number_of_axles: 5 },
      { number_of_axles: 8 },
      { description: "Van executiva", number_of_axles: 2 },
      { description: "Ônibus urbano", number_of_axles: 3 },
    ];

    validUpdates.forEach((payload) => {
      const result = updateVehicleTypeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  it("should accept valid payload with realistic vehicle type names", () => {
    const payload = {
      description: "Carreta LS 6x4 atualizada",
      number_of_axles: 5,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid payload with special characters in middle", () => {
    const payload = {
      description: "Caminhão-baú 3/4 turbo v2.0",
      number_of_axles: 3,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle partial updates with only description", () => {
    const payload = {
      description: "Novo tipo de veículo",
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle partial updates with only number_of_axles", () => {
    const payload = {
      number_of_axles: 4,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if description is provided but too short", () => {
    const payload = {
      description: "A",
      number_of_axles: 2,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should accept very edge case with exactly minimum requirements", () => {
    const payload = {
      description: "ABC",
      number_of_axles: 1,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept very edge case with exactly maximum requirements", () => {
    const payload = {
      description: "a".repeat(100),
      number_of_axles: 10,
    };

    const result = updateVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
