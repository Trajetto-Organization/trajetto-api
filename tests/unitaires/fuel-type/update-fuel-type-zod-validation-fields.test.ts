import { describe, it, expect } from "vitest";
import { updateFuelTypeSchema } from "@/schemas/update-fuel-type-schema";

describe("Update Fuel Type Zod Validation Fields", () => {
  it("should validate a valid complete fuel type update payload", () => {
    const payload = {
      description: "Diesel",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to Gasolina", () => {
    const payload = {
      description: "Gasolina",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to Etanol", () => {
    const payload = {
      description: "Etanol",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to GNV", () => {
    const payload = {
      description: "GNV",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to GLP", () => {
    const payload = {
      description: "GLP",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to Biodiesel", () => {
    const payload = {
      description: "Biodiesel",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to Elétrico", () => {
    const payload = {
      description: "Elétrico",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating to Hidrogênio", () => {
    const payload = {
      description: "Hidrogênio",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate all allowed fuel types for updates", () => {
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
      const result = updateFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(true);
    });
  });

  it("should validate empty payload", () => {
    const payload = {};

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept empty string description", () => {
    const payload = {
      description: "",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept undefined description", () => {
    const payload = {
      description: undefined,
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the description is null", () => {
    const payload = {
      description: null,
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail if the description is invalid fuel type", () => {
    const payload = {
      description: "Alcool",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for case-sensitive invalid fuel type (lowercase)", () => {
    const payload = {
      description: "gasolina",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for case-sensitive invalid fuel type (uppercase)", () => {
    const payload = {
      description: "DIESEL",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for mixed case invalid fuel type", () => {
    const payload = {
      description: "dIeSeL",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with extra spaces", () => {
    const payload = {
      description: " Etanol ",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with leading spaces", () => {
    const payload = {
      description: " GNV",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for fuel type with trailing spaces", () => {
    const payload = {
      description: "GLP ",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for completely invalid fuel type", () => {
    const payload = {
      description: "Querosene",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for numeric description", () => {
    const payload = {
      description: 123,
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for boolean description", () => {
    const payload = {
      description: true,
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for array description", () => {
    const payload = {
      description: ["Biodiesel"],
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for object description", () => {
    const payload = {
      description: { type: "Elétrico" },
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toBeDefined();
  });

  it("should fail for description with special characters", () => {
    const payload = {
      description: "Diesel@2024",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for description with numbers", () => {
    const payload = {
      description: "Gasolina95",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

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
      const result = updateFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });

  it("should accept only exact enum matches when description is provided", () => {
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
      const result = updateFuelTypeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  it("should handle payload with extra fields", () => {
    const payload = {
      description: "Hidrogênio",
      extraField: "should be ignored",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.description).toBe("Hidrogênio");
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
      const result = updateFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });

  it("should fail for only whitespace description", () => {
    const payload = {
      description: "   ",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for tab character description", () => {
    const payload = {
      description: "\t",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  it("should fail for newline character description", () => {
    const payload = {
      description: "\n",
    };

    const result = updateFuelTypeSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().description?._errors).toContain(
      "Combustível inválido. Selecione uma opção válida.",
    );
  });

  // Optional field handling tests
  it("should handle partial update with only valid description", () => {
    const payload = {
      description: "Biodiesel",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate all fuel type options as individual updates", () => {
    const fuelTypeUpdates = [
      { description: "Gasolina" },
      { description: "Diesel" },
      { description: "Etanol" },
      { description: "GNV" },
      { description: "GLP" },
      { description: "Biodiesel" },
      { description: "Elétrico" },
      { description: "Hidrogênio" },
      { description: "" }, // empty string is allowed for optional
      {}, // empty payload is allowed
    ];

    fuelTypeUpdates.forEach((update) => {
      const result = updateFuelTypeSchema.safeParse(update);
      expect(result.success).toBe(true);
    });
  });

  it("should fail for invalid fuel type even in update context", () => {
    const invalidUpdates = [
      { description: "Invalid Fuel" },
      { description: "Alcool Comum" },
      { description: "Gasolina Premium" },
      { description: "S10" },
      { description: "S500" },
      { description: "Arla32" },
    ];

    invalidUpdates.forEach((invalidUpdate) => {
      const result = updateFuelTypeSchema.safeParse(invalidUpdate);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });

  it("should handle empty string as valid optional value", () => {
    const payload = {
      description: "",
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.description).toBe("");
    }
  });

  it("should handle undefined as valid optional value", () => {
    const payload = {
      description: undefined,
    };

    const result = updateFuelTypeSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate realistic fuel type update scenarios", () => {
    const realScenarios = [
      {}, // no changes
      { description: "" }, // clearing description
      { description: "Gasolina" }, // changing to gasoline
      { description: "Diesel" }, // changing to diesel
      { description: "Etanol" }, // changing to ethanol
      { description: "GNV" }, // changing to natural gas
      { description: "Elétrico" }, // changing to electric
    ];

    realScenarios.forEach((scenario) => {
      const result = updateFuelTypeSchema.safeParse(scenario);
      expect(result.success).toBe(true);
    });
  });

  it("should maintain strict enum validation even for updates", () => {
    const variations = [
      "gasolina", // lowercase
      "DIESEL", // uppercase
      "Etanol ", // with trailing space
      " GNV", // with leading space
      "G L P", // with spaces inside
      "Elétrico.", // with period
      "Hidrogênio?", // with question mark
    ];

    variations.forEach((variation) => {
      const payload = { description: variation };
      const result = updateFuelTypeSchema.safeParse(payload);

      expect(result.success).toBe(false);
      expect(result.error?.format().description?._errors).toContain(
        "Combustível inválido. Selecione uma opção válida.",
      );
    });
  });
});
