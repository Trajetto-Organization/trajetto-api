import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createBusinessSchema } from "@/schemas/create-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listBusinessSchema } from "@/schemas/list-business-schema";

describe("Create Business Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      complement: "Sala 10",
      cnae: "1234567",
      corporate_reason: "Empresa Exemplo LTDA",
      email: "empresa@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "ERP123",
      fantasy_name: "Empresa Exemplo",
    };

    const parsed = createBusinessSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept empty strings for optional fields", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      complement: "",
      cnae: "1234567",
      corporate_reason: "Empresa Exemplo LTDA",
      email: "empresa@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "",
      fantasy_name: "",
    };

    const parsed = createBusinessSchema.parse(data);
    expect(parsed).toEqual(data);
  });

  it("should validate CEP field", () => {
    const testCases = [
      {
        field: "cep",
        value: "1234567", // Missing digit
        errorMessage: "O CEP deve ter exatamente 8 dígitos.",
      },
      {
        field: "cep",
        value: "1234567a", // Non-numeric character
        errorMessage: "O CEP deve conter apenas números.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate city field", () => {
    const testCases = [
      {
        field: "city",
        value: "A", // Too short
        errorMessage: "A cidade deve ter no mínimo 2 caracteres.",
      },
      {
        field: "city",
        value: "A".repeat(101), // Too long
        errorMessage: "A cidade deve ter no máximo 100 caracteres.",
      },
      {
        field: "city",
        value: "  ", // Empty or whitespace
        errorMessage:
          "O nome da cidade não pode ser vazio ou conter apenas espaços.",
      },
      {
        field: "city",
        value: "São  Paulo", // Consecutive spaces
        errorMessage: "O nome da cidade não deve conter espaços consecutivos.",
      },
      {
        field: "city",
        value: " São Paulo", // Space at beginning
        errorMessage:
          "O nome da cidade não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "city",
        value: "São Paulo ", // Space at end
        errorMessage:
          "O nome da cidade não pode começar ou terminar com espaço em branco.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  describe("should validate UF field", () => {
    it("should fail for invalid uf values", () => {
      const data = { uf: "S" };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          expect(error.errors.length).toBeGreaterThan(0);
          const lengthError = error.errors.some(
            (e) =>
              e.message.includes("2") ||
              e.message.includes("caracteres") ||
              e.message.includes("UF"),
          );
          expect(lengthError).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }

      const testValues = ["SSP", " SP", "SP ", "S P"];
      testValues.forEach((value) => {
        try {
          createBusinessSchema.parse({ uf: value });
          expect.fail(
            `Expected validation to fail for '${value}' but it succeeded.`,
          );
        } catch (error) {
          if (error instanceof ZodError) {
            expect(error.errors.length).toBeGreaterThan(0);
          } else {
            expect.fail("Unexpected error type");
          }
        }
      });

      try {
        createBusinessSchema.parse({ uf: "  " });
        expect.fail(
          "Expected validation to fail for consecutive spaces but it succeeded.",
        );
      } catch (error) {
        if (error instanceof ZodError) {
          expect(error.errors.length).toBeGreaterThan(0);
          const consecutiveSpacesError = error.errors.some((e) =>
            e.message.includes("consecutivos"),
          );
          expect(consecutiveSpacesError).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate street field", () => {
    const testCases = [
      {
        field: "street",
        value: "AB", // Too short
        errorMessage: "O nome da rua deve ter no mínimo 3 caracteres.",
      },
      {
        field: "street",
        value: "A".repeat(101), // Too long
        errorMessage: "O nome da rua deve ter no máximo 100 caracteres.",
      },
      {
        field: "street",
        value: "   ", // Whitespace only
        errorMessage:
          "O nome da rua não pode ser vazio ou conter apenas espaços.",
      },
      {
        field: "street",
        value: "Rua  Exemplo", // Consecutive spaces
        errorMessage: "O nome da rua não deve conter espaços consecutivos.",
      },
      {
        field: "street",
        value: " Rua Exemplo", // Space at beginning
        errorMessage:
          "O nome da rua não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "street",
        value: "Rua Exemplo ", // Space at end
        errorMessage:
          "O nome da rua não pode começar ou terminar com espaço em branco.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate address_number field", () => {
    const testCases = [
      {
        field: "address_number",
        value: "12345678901", // Too long
        errorMessage: "O número do endereço deve ter no máximo 10 caracteres.",
      },
      {
        field: "address_number",
        value: "  ", // Whitespace only
        errorMessage:
          "O número do endereço não pode ser vazio ou conter apenas espaços.",
      },
      {
        field: "address_number",
        value: "12  3", // Consecutive spaces
        errorMessage:
          "O número do endereço não deve conter espaços consecutivos.",
      },
      {
        field: "address_number",
        value: "12-A", // Invalid format
        errorMessage:
          "O número do endereço deve conter apenas números e letras.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate CNPJ field", () => {
    const testCases = [
      {
        field: "cnpj",
        value: "1234567890123", // Too short
        errorMessage: "O CNPJ deve ter exatamente 14 dígitos.",
      },
      {
        field: "cnpj",
        value: "123456789012345", // Too long
        errorMessage: "O CNPJ deve ter exatamente 14 dígitos.",
      },
      {
        field: "cnpj",
        value: "1234567890123A", // Non-numeric
        errorMessage: "O CNPJ deve conter apenas números.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate complement field", () => {
    const testCases = [
      {
        field: "complement",
        value: "A".repeat(51), // Too long
        errorMessage: "O complemento deve ter no máximo 50 caracteres.",
      },
      {
        field: "complement",
        value: "Sala  10", // Consecutive spaces
        errorMessage:
          "O nome do complemento não deve conter espaços consecutivos.",
      },
      {
        field: "complement",
        value: " Sala 10", // Space at beginning
        errorMessage:
          "O nome do complemento não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "complement",
        value: "Sala 10 ", // Space at end
        errorMessage:
          "O nome do complemento não pode começar ou terminar com espaço em branco.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate CNAE field", () => {
    const testCases = [
      {
        field: "cnae",
        value: "123456", // Too short
        errorMessage: "O CNAE deve ter exatamente 7 dígitos numéricos.",
      },
      {
        field: "cnae",
        value: "12345678", // Too long
        errorMessage: "O CNAE deve ter exatamente 7 dígitos numéricos.",
      },
      {
        field: "cnae",
        value: "123456A", // Non-numeric
        errorMessage: "O CNAE deve conter apenas números.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate corporate_reason field", () => {
    const testCases = [
      {
        field: "corporate_reason",
        value: "A".repeat(151), // Too long
        errorMessage: "A razão social deve ter no máximo 150 caracteres.",
      },
      {
        field: "corporate_reason",
        value: "  ", // Whitespace only
        errorMessage:
          "O nome da razão social não pode ser vazio ou conter apenas espaços.",
      },
      {
        field: "corporate_reason",
        value: "Empresa  Exemplo", // Consecutive spaces
        errorMessage:
          "O nome da razão social não deve conter espaços consecutivos.",
      },
      {
        field: "corporate_reason",
        value: " Empresa Exemplo", // Space at beginning
        errorMessage:
          "A razão social não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "corporate_reason",
        value: "Empresa Exemplo ", // Space at end
        errorMessage:
          "A razão social não pode começar ou terminar com espaço em branco.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate email field", () => {
    const testCases = [
      {
        field: "email",
        value: "email_invalido", // Invalid format
        errorMessage: "O e-mail informado não é válido.",
      },
      {
        field: "email",
        value: "a".repeat(90) + "@example.com", // Too long
        errorMessage: "O e-mail deve ter no máximo 100 caracteres.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate responsible_name field", () => {
    const testCases = [
      {
        field: "responsible_name",
        value: "A".repeat(101), // Too long
        errorMessage: "O nome não deve exceder 100 caracteres.",
      },
      {
        field: "responsible_name",
        value: "João  Silva", // Consecutive spaces
        errorMessage: "O nome não deve conter espaços consecutivos.",
      },
      {
        field: "responsible_name",
        value: "João", // Not full name
        errorMessage: "Por favor, insira o nome completo.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate telephone field", () => {
    const testCases = [
      {
        field: "telephone",
        value: "123456789", // Too short
        errorMessage:
          "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      },
      {
        field: "telephone",
        value: "123456789012", // Too long
        errorMessage:
          "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      },
      {
        field: "telephone",
        value: "1234567A90", // Non-numeric
        errorMessage:
          "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate erp_code field", () => {
    const testCases = [
      {
        field: "erp_code",
        value: "A".repeat(51), // Too long
        errorMessage: "O código ERP deve ter no máximo 50 caracteres.",
      },
      {
        field: "erp_code",
        value: "ERP  123", // Consecutive spaces
        errorMessage: "O código ERP não deve conter espaços consecutivos.",
      },
      {
        field: "erp_code",
        value: " ERP123", // Space at beginning
        errorMessage:
          "O código ERP não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "erp_code",
        value: "ERP123 ", // Space at end
        errorMessage:
          "O código ERP não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "erp_code",
        value: "ERP@123", // Invalid character
        errorMessage:
          "O código ERP deve conter apenas letras, números, traços ou underscores",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate fantasy_name field", () => {
    const testCases = [
      {
        field: "fantasy_name",
        value: "A".repeat(101), // Too long
        errorMessage: "O nome fantasia deve ter no máximo 100 caracteres.",
      },
      {
        field: "fantasy_name",
        value: "Empresa  Exemplo", // Consecutive spaces
        errorMessage: "O nome fantasia não deve conter espaços consecutivos.",
      },
      {
        field: "fantasy_name",
        value: " Empresa Exemplo", // Space at beginning
        errorMessage:
          "O nome fantasia não pode começar ou terminar com espaço em branco.",
      },
      {
        field: "fantasy_name",
        value: "Empresa Exemplo ", // Space at end
        errorMessage:
          "O nome fantasia não pode começar ou terminar com espaço em branco.",
      },
    ];

    testCases.forEach(({ field, value, errorMessage }) => {
      const data = { [field]: value };

      try {
        createBusinessSchema.parse(data);
        expect.fail("Expected validation to fail but it succeeded.");
      } catch (error) {
        if (error instanceof ZodError) {
          const hasMessage = error.errors.some((e) =>
            e.message.includes(errorMessage),
          );
          expect(hasMessage).toBeTruthy();
        } else {
          expect.fail("Unexpected error type");
        }
      }
    });
  });

  it("should validate a valid businessId", () => {
    const validData = { businessId: "123" };
    const parsed = updateDeleteBusinessSchema.parse(validData);

    expect(parsed.businessId).toBe("123");
  });

  it("should throw error if businessId is empty", () => {
    expect(() => {
      updateDeleteBusinessSchema.parse({ businessId: "" });
    }).toThrowError(ZodError);

    try {
      updateDeleteBusinessSchema.parse({ businessId: "" });
      expect.fail("Validation should fail for empty businessId");
    } catch (error) {
      if (error instanceof ZodError) {
        const hasExpectedMessage = error.errors.some((err) =>
          err.message.includes("O ID da empresa é obrigatório!"),
        );
        expect(hasExpectedMessage).toBeTruthy();
      }
    }
  });

  it("should validate valid query parameters", () => {
    const validData = { page: "2", pageSize: "5" };
    const parsed = listBusinessSchema.parse(validData);

    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(5);
  });

  it("should default page to 1 if invalid", () => {
    const data = { page: "", pageSize: "5" };
    const parsed = listBusinessSchema.parse(data);

    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(5);
  });

  it("should default pageSize to 2 if invalid", () => {
    const data = { page: "2", pageSize: "" };
    const parsed = listBusinessSchema.parse(data);

    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(2);
  });
});
