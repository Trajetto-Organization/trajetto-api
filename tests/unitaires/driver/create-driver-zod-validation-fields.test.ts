import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createDriverSchema } from "@/schemas/create-driver-schema";

describe("Create Driver Zod Validation Fields", () => {
  it("should pass validation with valid data", () => {
    const validData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      complement: "Apt 10",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      branchId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createDriverSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should accept null/undefined for optional fields", () => {
    const validData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(validData);
    expect(parsed).toEqual(validData);
  });

  it("should convert empty strings to null for optional fields", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      complement: "",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      branchId: "",
    };

    const parsed = createDriverSchema.parse(data);

    expect(parsed.complement).toBeNull();
    expect(parsed.branchId).toBeNull();
  });

  // Name validations
  it("should reject name with less than 3 characters", () => {
    const invalidData = {
      name: "Jo",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome deve ter no mínimo 3 caracteres.",
    );
  });

  it("should reject name with more than 100 characters", () => {
    const invalidData = {
      name: "A".repeat(95) + " " + "B".repeat(10),
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome não deve exceder 100 caracteres.",
    );
  });

  it("should reject name with consecutive spaces", () => {
    const invalidData = {
      name: "João  Silva",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome não deve conter espaços consecutivos.",
    );
  });

  it("should reject name with spaces at edges", () => {
    const invalidData = {
      name: " João Silva ",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should reject incomplete name (single word)", () => {
    const invalidData = {
      name: "João",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "Por favor, insira o nome completo.",
    );
  });

  // Birth date validations
  it("should reject empty birth date", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "A data de nascimento é obrigatória.",
    );
  });

  it("should reject invalid birth date format", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "invalid-date",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "Data de nascimento inválida.",
    );
  });

  it("should reject birth date for person under 18 years old", () => {
    const today = new Date();
    const underageDate = new Date(
      today.getFullYear() - 17,
      today.getMonth(),
      today.getDate(),
    )
      .toISOString()
      .split("T")[0];

    const invalidData = {
      name: "João Silva Santos",
      birth_date: underageDate,
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O motorista deve ter pelo menos 18 anos.",
    );
  });

  it("should accept birth date for person exactly 18 years old", () => {
    const today = new Date();
    const exactlyEighteenDate = new Date(
      today.getFullYear() - 18,
      today.getMonth(),
      today.getDate(),
    )
      .toISOString()
      .split("T")[0];

    const validData = {
      name: "João Silva Santos",
      birth_date: exactlyEighteenDate,
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(validData);
    expect(parsed.birth_date).toBe(exactlyEighteenDate);
  });

  // CNH validations
  it("should reject empty CNH", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número da CNH é obrigatório.",
    );
  });

  it("should reject CNH with more than 20 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "1".repeat(21),
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número da CNH deve ter no máximo 20 caracteres.",
    );
  });

  // CPF validations
  it("should format CPF by removing non-numeric characters", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "123.456.789-01",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.cpf).toBe("12345678901");
  });

  it("should reject CPF with invalid length", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "123456789", // 9 digits instead of 11
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O CPF deve ter exatamente 11 dígitos.",
    );
  });

  it("should reject CPF with non-numeric characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "1234567890A",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O CPF deve conter apenas números.",
    );
  });

  // RG validations
  it("should reject empty RG", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número do RG é obrigatório.",
    );
  });

  it("should reject RG with more than 20 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "1".repeat(21),
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número do RG deve ter no máximo 20 caracteres.",
    );
  });

  // CEP validations
  it("should format CEP by removing non-numeric characters", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345-678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.cep).toBe("12345678");
  });

  it("should reject CEP with invalid length", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "1234567", // 7 digits instead of 8
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O CEP deve ter exatamente 8 dígitos.",
    );
  });

  it("should reject CEP with non-numeric characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "1234567A",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O CEP deve conter apenas números.",
    );
  });

  // City validations
  it("should reject city with less than 2 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "S",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no mínimo 2 caracteres.",
    );
  });

  it("should reject city with more than 100 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "A".repeat(101),
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "A cidade deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject city with whitespace only", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "   ",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da cidade não pode ser vazio ou conter apenas espaços.",
    );
  });

  it("should reject city with consecutive spaces", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São  Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da cidade não deve conter espaços consecutivos.",
    );
  });

  it("should reject city with spaces at edges", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: " São Paulo ",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da cidade não pode começar ou terminar com espaço em branco.",
    );
  });

  // UF validations
  it("should reject UF with invalid length", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SAO",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "UF deve ter exatamente 2 caracteres.",
    );
  });

  it("should convert UF to uppercase", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "sp",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.uf).toBe("SP");
  });

  it("should reject UF with numbers", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "S1",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O UF deve conter apenas letras sem números, símbolos ou traços.",
    );
  });

  // Street validations
  it("should reject street with less than 3 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Ru",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da rua deve ter no mínimo 3 caracteres.",
    );
  });

  it("should reject street with more than 100 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "A".repeat(101),
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da rua deve ter no máximo 100 caracteres.",
    );
  });

  it("should reject street with whitespace only", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "   ",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O nome da rua não pode ser vazio ou conter apenas espaços.",
    );
  });

  // Address number validations
  it("should reject empty address number", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número do endereço é obrigatório.",
    );
  });

  it("should accept address number with letter", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123A",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.address_number).toBe("123A");
  });

  it("should reject address number with more than 10 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "12345678901",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número do endereço deve ter no máximo 10 caracteres.",
    );
  });

  it("should reject address number with invalid format", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123-A",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O número do endereço deve conter apenas números e letras.",
    );
  });

  // Complement validations
  it("should accept valid complement", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      complement: "Apt 10",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.complement).toBe("Apt 10");
  });

  it("should reject complement longer than 50 characters", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      complement: "A".repeat(51),
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O complemento deve ter no máximo 50 caracteres.",
    );
  });

  // Status validations
  it("should reject invalid status", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "INVALID" as any,
      contract_type: "OWNED" as const,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O status deve ser 'ACTIVE' ou 'INACTIVE'",
    );
  });

  // Contract type validations
  it("should reject invalid contract type", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "INVALID" as any,
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O tipo de contrato deve ser 'OWNED' ou 'THIRD_PARTY'",
    );
  });

  // Branch ID validations
  it("should reject invalid UUID for branchId", () => {
    const invalidData = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      branchId: "invalid-uuid",
    };

    expect(() => createDriverSchema.parse(invalidData)).toThrow(ZodError);
    expect(() => createDriverSchema.parse(invalidData)).toThrow(
      "O ID da filial deve ser um UUID válido.",
    );
  });

  it("should accept valid UUID for branchId", () => {
    const data = {
      name: "João Silva Santos",
      birth_date: "1990-01-15",
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      branchId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const parsed = createDriverSchema.parse(data);
    expect(parsed.branchId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
