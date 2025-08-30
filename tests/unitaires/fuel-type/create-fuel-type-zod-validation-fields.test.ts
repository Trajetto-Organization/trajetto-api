import { describe, it, expect } from "vitest";
import { createFuelTypeSchema } from "@/schemas/create-fuel-type-schema";

describe("Create Fuel Type Zod Validation Fields", () => {
  it("should validate a valid fuel type payload with Gasolina", () => {
    const payload = {
      description: "Gasolina",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with Diesel", () => {
    const payload = {
      description: "Diesel",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with Etanol", () => {
    const payload = {
      description: "Etanol",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with GNV", () => {
    const payload = {
      description: "GNV",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with GLP", () => {
    const payload = {
      description: "GLP",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with Biodiesel", () => {
    const payload = {
      description: "Biodiesel",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with Elétrico", () => {
    const payload = {
      description: "Elétrico",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid fuel type payload with Hidrogênio", () => {
    const payload = {
      description: "Hidrogênio",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate all allowed fuel types", () => {
    const allowedFuelTypes = [
      "Gasolina",
      "Diesel",
      "Etanol",
      "GNV",
      "GLP",
      "Biodiesel",
      "Elétrico",
      "Hidrogênio",
    ];

    allowedFuelTypes.forEach((fuelType) => {
      const payload = { description: fuelType };
      const result = createFuelTypeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  it("should fail if the description is missing", () => {
    const payload = {};

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is null", () => {
    const payload = {
      description: null,
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is undefined", () => {
    const payload = {
      description: undefined,
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is empty string", () => {
    const payload = {
      description: "",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail if the description is invalid fuel type", () => {
    const payload = {
      description: "Alcool",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for case-sensitive invalid fuel type (lowercase)", () => {
    const payload = {
      description: "gasolina",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for case-sensitive invalid fuel type (uppercase)", () => {
    const payload = {
      description: "GASOLINA",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for mixed case invalid fuel type", () => {
    const payload = {
      description: "gAsOlInA",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with extra spaces", () => {
    const payload = {
      description: " Gasolina ",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with leading spaces", () => {
    const payload = {
      description: " Gasolina",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with trailing spaces", () => {
    const payload = {
      description: "Gasolina ",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for completely invalid fuel type", () => {
    const payload = {
      description: "Querosene",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for numeric description", () => {
    const payload = {
      description: 123,
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for boolean description", () => {
    const payload = {
      description: true,
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for array description", () => {
    const payload = {
      description: ["Gasolina"],
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for object description", () => {
    const payload = {
      description: { type: "Gasolina" },
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for description with special characters", () => {
    const payload = {
      description: "Gasolina@2024",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for description with numbers", () => {
    const payload = {
      description: "Gasolina95",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type variations", () => {
    const invalidFuelTypes = [
      "Gas",
      "Gasoline",
      "Petroleum",
      "Flex",
      "Bio",
      "Natural Gas",
      "Electric",
      "Hydrogen",
      "Álcool",
      "Combustível",
      "Fuel",
    ];

    invalidFuelTypes.forEach((invalidFuelType) => {
      const payload = { description: invalidFuelType };
      const result = createFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });

  it("should accept only exact enum matches", () => {
    const exactMatches = [
      "Gasolina",
      "Diesel",
      "Etanol",
      "GNV",
      "GLP",
      "Biodiesel",
      "Elétrico",
      "Hidrogênio",
    ];

    exactMatches.forEach((exactMatch) => {
      const payload = { description: exactMatch };
      const result = createFuelTypeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  it("should handle payload with extra fields", () => {
    const payload = {
      description: "Diesel",
      extraField: "should be ignored",
    };

    const result = createFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Diesel");
      expect(result.data).not.toHaveProperty("extraField");
    }
  });

  it("should fail for Unicode and special character variations", () => {
    const unicodeVariations = [
      "Gasolína", // with accent on í
      "Gasólina", // with accent on ó
      "Diésel", // with accent on é
      "Etanól", // with accent on ó
      "Eléctrico", // with accent on é
      "Hidrógênio", // different accent placement
    ];

    unicodeVariations.forEach((variation) => {
      const payload = { description: variation };
      const result = createFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });

  it("should fail for empty payload", () => {
    const payload = {};

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for only whitespace description", () => {
    const payload = {
      description: "   ",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for tab character description", () => {
    const payload = {
      description: "\t",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for newline character description", () => {
    const payload = {
      description: "\n",
    };

    const result = createFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });
});
