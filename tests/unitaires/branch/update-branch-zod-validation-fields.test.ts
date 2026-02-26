import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { updateBranchSchema } from "@/schemas/update-branch-schema";

describe("Update Branch Zod Validation Fields", () => {
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
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "ERP123",
      fantasy_name: "Filial Exemplo",
    };

    const parsed = updateBranchSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should pass validation with empty object", () => {
    const data = {};

    const parsed = updateBranchSchema.parse(data);
    expect(parsed).toEqual({});
  });

  it("should convert empty strings to null for optional fields", () => {
    const data = {
      cep: "",
      city: "",
      uf: "",
      street: "",
      address_number: "",
      cnpj: "",
      complement: "",
      cnae: "",
      corporate_reason: "",
      email: "",
      responsible_name: "",
      telephone: "",
      erp_code: "",
      fantasy_name: "",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed).toEqual({
      cep: null,
      city: null,
      uf: null,
      street: null,
      address_number: null,
      cnpj: null,
      complement: null,
      cnae: null,
      corporate_reason: null,
      email: null,
      responsible_name: null,
      telephone: null,
      erp_code: null,
      fantasy_name: null,
    });
  });

  it("should accept partial data", () => {
    const data = {
      city: "Rio de Janeiro",
      email: "newfilial@example.com",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed).toEqual(data);
  });

  // CEP validations
  it("should reject CEP with invalid format", () => {
    const invalidData = {
      cep: "1234567", // 7 digits instead of 8
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O CEP deve ter exatamente 8 dígitos.",
    );
  });

  it("should format CEP by removing non-numeric characters", () => {
    const data = {
      cep: "12345-678",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.cep).toBe("12345678");
  });

  // City validations
  it("should reject city with less than 2 characters", () => {
    const invalidData = {
      city: "S",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject city with more than 100 characters", () => {
    const invalidData = {
      city: "A".repeat(101),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no máximo 100 caracteres.",
    );
  });

  it("should convert whitespace-only city to null", () => {
    const data = {
      city: "   ",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.city).toBeNull();
  });

  it("should reject city with consecutive spaces", () => {
    const invalidData = {
      city: "São  Paulo",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome da cidade não deve conter espaços consecutivos.",
    );
  });

  it("should reject city with spaces at edges", () => {
    const invalidData = {
      city: " São Paulo ",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome da cidade não pode começar ou terminar com espaço em branco.",
    );
  });

  // UF validations
  it("should reject UF with invalid length", () => {
    const invalidData = {
      uf: "SAO",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "UF deve ter exatamente 2 caracteres.",
    );
  });

  it("should convert UF to uppercase", () => {
    const data = {
      uf: "sp",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.uf).toBe("SP");
  });

  it("should reject UF with numbers", () => {
    const invalidData = {
      uf: "S1",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O UF deve conter apenas letras sem números, símbolos ou traços.",
    );
  });

  // Street validations
  it("should reject street with less than 3 characters", () => {
    const invalidData = {
      street: "Ru",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome da rua deve ter no mínimo 3 caracteres.",
    );
  });

  it("should reject street with more than 100 characters", () => {
    const invalidData = {
      street: "A".repeat(101),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome da rua deve ter no máximo 100 caracteres.",
    );
  });

  it("should convert whitespace-only street to null", () => {
    const data = {
      street: "   ",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.street).toBeNull();
  });

  // CNPJ validations
  it("should reject CNPJ with invalid format", () => {
    const invalidData = {
      cnpj: "123456780001", // 12 digits instead of 14
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O CNPJ deve ter exatamente 14 dígitos.",
    );
  });

  it("should format CNPJ by removing non-numeric characters", () => {
    const data = {
      cnpj: "12.345.678/0001-95",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.cnpj).toBe("12345678000195");
  });

  // CNAE validations
  it("should reject CNAE with invalid format", () => {
    const invalidData = {
      cnae: "123456", // 6 digits instead of 7
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O CNAE deve ter exatamente 7 dígitos numéricos.",
    );
  });

  it("should reject CNAE with non-numeric characters", () => {
    const invalidData = {
      cnae: "123456A",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O CNAE deve conter apenas números.",
    );
  });

  // Corporate reason validations
  it("should convert whitespace-only corporate_reason to null", () => {
    const data = {
      corporate_reason: "   ",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.corporate_reason).toBeNull();
  });

  it("should reject corporate reason with more than 150 characters", () => {
    const invalidData = {
      corporate_reason: "A".repeat(151),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "A razão social deve ter no máximo 150 caracteres.",
    );
  });

  it("should reject corporate reason with consecutive spaces", () => {
    const invalidData = {
      corporate_reason: "Filial  Exemplo",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome da razão social não deve conter espaços consecutivos.",
    );
  });

  // Email validations
  it("should reject invalid email format", () => {
    const invalidData = {
      email: "invalid-email",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O e-mail informado não é válido.",
    );
  });

  it("should convert whitespace-only email to null", () => {
    const data = {
      email: "   ",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.email).toBeNull();
  });

  it("should reject email longer than 100 characters", () => {
    const invalidData = {
      email: "a".repeat(90) + "@example.com", // More than 100 chars
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O e-mail deve ter no máximo 100 caracteres.",
    );
  });

  // Responsible name validations
  it("should reject incomplete name (single word)", () => {
    const invalidData = {
      responsible_name: "João",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "Por favor, insira o nome completo.",
    );
  });

  it("should reject name longer than 100 characters", () => {
    const invalidData = {
      responsible_name: "A".repeat(95) + " " + "B".repeat(10),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should reject name with consecutive spaces", () => {
    const invalidData = {
      responsible_name: "João  Silva",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  // Telephone validations
  it("should accept valid telephone with 10 digits", () => {
    const data = {
      telephone: "1187654321",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.telephone).toBe("1187654321");
  });

  it("should accept valid telephone with 11 digits", () => {
    const data = {
      telephone: "11987654321",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.telephone).toBe("11987654321");
  });

  it("should format telephone by removing non-numeric characters", () => {
    const data = {
      telephone: "(11) 98765-4321",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.telephone).toBe("11987654321");
  });

  it("should reject telephone with invalid length", () => {
    const invalidData = {
      telephone: "123456789", // 9 digits
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
    );
  });

  // Address number validations
  it("should convert whitespace-only address_number to null", () => {
    const data = {
      address_number: "   ",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.address_number).toBeNull();
  });

  it("should accept address number with letter", () => {
    const data = {
      address_number: "123A",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.address_number).toBe("123A");
  });

  it("should reject address number longer than 10 characters", () => {
    const invalidData = {
      address_number: "12345678901",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O número do endereço deve ter no máximo 10 caracteres.",
    );
  });

  // ERP code validations
  it("should accept valid ERP code", () => {
    const data = {
      erp_code: "ERP-123_ABC",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.erp_code).toBe("ERP-123_ABC");
  });

  it("should reject ERP code longer than 50 characters", () => {
    const invalidData = {
      erp_code: "A".repeat(51),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O código ERP deve ter no máximo 50 caracteres.",
    );
  });

  it("should reject ERP code with consecutive spaces", () => {
    const invalidData = {
      erp_code: "ERP  123",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O código ERP não deve conter espaços consecutivos.",
    );
  });

  it("should reject ERP code with spaces at edges", () => {
    const invalidData = {
      erp_code: " ERP123 ",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O código ERP não pode começar ou terminar com espaço em branco.",
    );
  });

  // Fantasy name validations
  it("should accept valid fantasy name", () => {
    const data = {
      fantasy_name: "Filial São Paulo",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.fantasy_name).toBe("Filial São Paulo");
  });

  it("should reject fantasy name longer than 100 characters", () => {
    const invalidData = {
      fantasy_name: "A".repeat(101),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome fantasia deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject fantasy name with consecutive spaces", () => {
    const invalidData = {
      fantasy_name: "Filial  São Paulo",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome fantasia não deve conter espaços consecutivos.",
    );
  });

  it("should reject fantasy name with spaces at edges", () => {
    const invalidData = {
      fantasy_name: " Filial São Paulo ",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome fantasia não pode começar ou terminar com espaço em branco.",
    );
  });

  // Complement validations
  it("should accept valid complement", () => {
    const data = {
      complement: "Sala 10",
    };

    const parsed = updateBranchSchema.parse(data);
    expect(parsed.complement).toBe("Sala 10");
  });

  it("should reject complement longer than 50 characters", () => {
    const invalidData = {
      complement: "A".repeat(51),
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O complemento deve ter no máximo 50 caracteres.",
    );
  });

  it("should reject complement with consecutive spaces", () => {
    const invalidData = {
      complement: "Sala  10",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome do complemento não deve conter espaços consecutivos.",
    );
  });

  it("should reject complement with spaces at edges", () => {
    const invalidData = {
      complement: " Sala 10 ",
    };

    expect(() => updateBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => updateBranchSchema.parse(invalidData)).toThrow(
      "O nome do complemento não pode começar ou terminar com espaço em branco.",
    );
  });
});
