import { describe, it, expect } from "vitest";
import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";

describe("Create Vehicle Type Zod Validation Fields", () => {
  it("should validate a valid complete vehicle type payload", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid vehicle type payload with maximum axles", () => {
    const payload = {
      description: "Carreta bi-trem",
      number_of_axles: 10,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid vehicle type payload with minimum axles", () => {
    const payload = {
      description: "Moto",
      number_of_axles: 1,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the description is missing", () => {
    const payload = {
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is empty", () => {
    const payload = {
      description: "",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description is too short", () => {
    const payload = {
      description: "AB",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the description exceeds 100 characters", () => {
    const payload = {
      description: "a".repeat(101),
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the description contains consecutive spaces", () => {
    const payload = {
      description: "Caminhão  3/4  carroceria",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the description has spaces at edges", () => {
    const payload = {
      description: " Caminhão 3/4 ",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at beginning only", () => {
    const payload = {
      description: " Caminhão 3/4",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description has space at end only", () => {
    const payload = {
      description: "Caminhão 3/4 ",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the description starts with symbol", () => {
    const payload = {
      description: "@Caminhão 3/4",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should fail if the description ends with symbol", () => {
    const payload = {
      description: "Caminhão 3/4@",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept valid description with symbols in the middle", () => {
    const payload = {
      description: "Caminhão@2024_v1.0-carroceria",
      number_of_axles: 3,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description with accented characters", () => {
    const payload = {
      description: "Caminhão de carga",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid description starting and ending with numbers", () => {
    const payload = {
      description: "2024 Caminhão modelo 3456",
      number_of_axles: 4,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if number_of_axles is missing", () => {
    const payload = {
      description: "Caminhão 3/4",
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is zero", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: 0,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should fail if number_of_axles is negative", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: -1,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should fail if number_of_axles exceeds maximum value", () => {
    const payload = {
      description: "Caminhão especial",
      number_of_axles: 11,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no máximo 10.",
    );
  });

  it("should accept valid number_of_axles at maximum boundary", () => {
    const payload = {
      description: "Carreta bi-trem especial",
      number_of_axles: 10,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid number_of_axles at minimum boundary", () => {
    const payload = {
      description: "Motocicleta",
      number_of_axles: 1,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if number_of_axles is not an integer", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: 2.5,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser um número inteiro.",
    );
  });

  it("should fail if number_of_axles is not a number", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: "2",
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should handle boundary case for description length at exactly 100 characters", () => {
    const payload = {
      description: "a".repeat(100),
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should handle boundary case for description length at exactly 3 characters", () => {
    const payload = {
      description: "Van",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail for description with only symbols", () => {
    const payload = {
      description: "@#$%&*",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
    );
  });

  it("should accept description with mixed valid characters", () => {
    const payload = {
      description: "A1B2-C3_D4.E5",
      number_of_axles: 3,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept common vehicle type descriptions", () => {
    const validVehicleTypes = [
      { description: "Carro", number_of_axles: 2 },
      { description: "Moto", number_of_axles: 1 },
      { description: "Caminhão 3/4", number_of_axles: 2 },
      { description: "Carreta", number_of_axles: 5 },
      { description: "Bi-trem", number_of_axles: 7 },
      { description: "Rodotrem", number_of_axles: 9 },
      { description: "Van", number_of_axles: 2 },
      { description: "Ônibus", number_of_axles: 3 },
      { description: "Micro-ônibus", number_of_axles: 2 },
      { description: "Caminhonete", number_of_axles: 2 },
    ];

    validVehicleTypes.forEach((vehicleType) => {
      const result = createVehicleTypeSchema.safeParse(vehicleType);
      expect(result.success).toBe(true);
    });
  });

  it("should fail with multiple invalid fields", () => {
    const payload = {
      description: "AB",
      number_of_axles: -1,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "A descrição deve ter no mínimo 3 caracteres.",
    );
    expect(result.error?.format().number_of_axles?._errors).toContain(
      "O número de eixos deve ser no mínimo 1.",
    );
  });

  it("should fail if number_of_axles is null", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: null,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is undefined", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: undefined,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is boolean", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: true,
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is array", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: [2],
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should fail if number_of_axles is object", () => {
    const payload = {
      description: "Caminhão 3/4",
      number_of_axles: { value: 2 },
    };

    const result = createVehicleTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().number_of_axles?._errors).toBeDefined();
  });

  it("should accept valid payload with realistic vehicle type names", () => {
    const payload = {
      description: "Carreta LS 6x2",
      number_of_axles: 4,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid payload with special characters in middle", () => {
    const payload = {
      description: "Caminhão-baú 3/4 turbo",
      number_of_axles: 2,
    };

    const result = createVehicleTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
