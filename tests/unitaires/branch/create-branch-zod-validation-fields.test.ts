import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createBranchSchema } from "@/schemas/create-branch-schema";

describe("Create Branch Zod Validation Fields", () => {
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

    const parsed = createBranchSchema.parse(validData);
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
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "",
      fantasy_name: "",
    };

    const expectedData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      complement: "",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "",
      fantasy_name: "",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed).toEqual(expectedData);
  });

  it("should accept undefined for optional fields", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed).toEqual(data);
  });

  // CEP validations
  it("should reject CEP with invalid format", () => {
    const invalidData = {
      cep: "1234567", // 7 digits instead of 8
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O CEP deve ter exatamente 8 dígitos.",
    );
  });

  it("should format CEP by removing non-numeric characters", () => {
    const data = {
      cep: "12345-678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.cep).toBe("12345678");
  });

  // City validations
  it("should reject city with less than 2 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "S",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject city with more than 100 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "A".repeat(101),
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject city with whitespace only", () => {
    const invalidData = {
      cep: "12345678",
      city: "   ",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O nome da cidade não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should reject city with consecutive spaces", () => {
    const invalidData = {
      cep: "12345678",
      city: "São  Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O nome da cidade não deve conter espaços consecutivos.",
    );
  });

  it("should reject city with spaces at edges", () => {
    const invalidData = {
      cep: "12345678",
      city: " São Paulo ",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O nome da cidade não pode começar ou terminar com espaço em branco.",
    );
  });

  // UF validations
  it("should reject UF with invalid length", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SAO",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "UF deve ter exatamente 2 caracteres.",
    );
  });

  it("should convert UF to uppercase", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "sp",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.uf).toBe("SP");
  });

  it("should reject UF with numbers", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "S1",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O UF deve conter apenas letras sem números, símbolos ou traços.",
    );
  });

  // CNPJ validations
  it("should reject CNPJ with invalid format", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "123456780001", // 12 digits instead of 14
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O CNPJ deve ter exatamente 14 dígitos.",
    );
  });

  it("should format CNPJ by removing non-numeric characters", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12.345.678/0001-95",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.cnpj).toBe("12345678000195");
  });

  // CNAE validations
  it("should reject CNAE with invalid format", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "123456", // 6 digits instead of 7
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O CNAE deve ter exatamente 7 dígitos numéricos.",
    );
  });

  it("should reject CNAE with non-numeric characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "123456A",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O CNAE deve conter apenas números.",
    );
  });

  // Corporate reason validations
  it("should reject empty corporate reason", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "A razão social é obrigatória.",
    );
  });

  it("should reject corporate reason with more than 150 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "A".repeat(151),
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "A razão social deve ter no máximo 150 caracteres.",
    );
  });

  // Email validations
  it("should reject invalid email format", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "invalid-email",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O e-mail informado não é válido.",
    );
  });

  it("should reject empty email", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O e-mail é obrigatório.",
    );
  });

  // Responsible name validations
  it("should reject incomplete name (single word)", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "Por favor, insira o nome completo.",
    );
  });

  it("should reject name longer than 100 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "A".repeat(95) + " " + "B".repeat(10),
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  // Telephone validations
  it("should accept valid telephone with 10 digits", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "1187654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.telephone).toBe("1187654321");
  });

  it("should accept valid telephone with 11 digits", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.telephone).toBe("11987654321");
  });

  it("should format telephone by removing non-numeric characters", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "(11) 98765-4321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.telephone).toBe("11987654321");
  });

  it("should reject telephone with invalid length", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "123456789", // 9 digits
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
    );
  });

  // Address number validations
  it("should reject empty address number", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O número do endereço é obrigatório.",
    );
  });

  it("should accept address number with letter", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123A",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.address_number).toBe("123A");
  });

  // ERP code validations
  it("should accept valid ERP code", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "ERP-123_ABC",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.erp_code).toBe("ERP-123_ABC");
  });

  it("should reject ERP code longer than 50 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      erp_code: "A".repeat(51),
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O código ERP deve ter no máximo 50 caracteres.",
    );
  });

  // Fantasy name validations
  it("should accept valid fantasy name", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      fantasy_name: "Filial São Paulo",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.fantasy_name).toBe("Filial São Paulo");
  });

  it("should reject fantasy name longer than 100 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      fantasy_name: "A".repeat(101),
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O nome fantasia deve ter no máximo 100 caracteres.",
    );
  });

  // Complement validations
  it("should accept valid complement", () => {
    const data = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      complement: "Sala 10",
    };

    const parsed = createBranchSchema.parse(data);
    expect(parsed.complement).toBe("Sala 10");
  });

  it("should reject complement longer than 50 characters", () => {
    const invalidData = {
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      cnpj: "12345678000195",
      cnae: "1234567",
      corporate_reason: "Filial Exemplo LTDA",
      email: "filial@example.com",
      responsible_name: "João Silva",
      telephone: "11987654321",
      complement: "A".repeat(51),
    };

    expect(() => createBranchSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createBranchSchema.parse(invalidData)).toThrow(
      "O complemento deve ter no máximo 50 caracteres.",
    );
  });
});
