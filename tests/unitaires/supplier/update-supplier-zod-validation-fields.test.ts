import { describe, it, expect } from "vitest";
import { updateSupplierSchema } from "@/schemas/update-supplier-schema";

describe("Update Supplier Zod Validation Fields", () => {
  it("should validate a valid complete supplier update payload", () => {
    const payload = {
      name: "Fornecedor Atualizado",
      cnpj: "12345678000100",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Atualizada",
      address_number: "456",
      complement: "Sala 2",
      telephone: "11987654321",
      email: "fornecedor@atualizado.com",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate a valid partial supplier update payload", () => {
    const payload = {
      name: "Fornecedor Parcial",
      cnpj: "12345678000100",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only email", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      email: "novo@email.com",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should validate updating only telephone", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      telephone: "11987654321",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the name is too short", () => {
    const payload = {
      name: "A",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do fornecedor deve ter no mínimo 2 caracteres.",
    );
  });

  it("should fail if the name exceeds 100 characters", () => {
    const payload = {
      name: "a".repeat(101),
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do fornecedor não deve exceder 100 caracteres.",
    );
  });

  it("should fail if the name contains consecutive spaces", () => {
    const payload = {
      name: "Fornecedor  Atualizado",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do fornecedor não deve conter espaços consecutivos.",
    );
  });

  it("should fail if the name has spaces at edges", () => {
    const payload = {
      name: " Fornecedor Atualizado ",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "O nome do fornecedor não pode começar ou terminar com espaço em branco.",
    );
  });

  it("should fail if the name is incomplete (only one word)", () => {
    const payload = {
      name: "Fornecedor",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().name?._errors).toContain(
      "Por favor, insira o nome do fornecedor completo.",
    );
  });

  it("should fail if the CNPJ is too short", () => {
    const payload = {
      cnpj: "1234567890123",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().cnpj?._errors).toContain(
      "O CNPJ deve ter exatamente 14 dígitos.",
    );
  });

  it("should fail if the CNPJ is too long", () => {
    const payload = {
      cnpj: "123456789012345",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().cnpj?._errors).toContain(
      "O CNPJ deve ter exatamente 14 dígitos.",
    );
  });

  it("should accept CNPJ with formatting and remove non-numeric characters", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12.345.678/0001-00",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.cnpj).toBe("12345678000100");
  });

  it("should fail if the CNPJ contains letters", () => {
    const payload = {
      cnpj: "1234567800010A",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().cnpj?._errors).toContain(
      "O CNPJ deve conter apenas números.",
    );
  });

  it("should fail if the CEP is invalid (wrong length)", () => {
    const payload = {
      cep: "1234567",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().cep?._errors).toContain(
      "O CEP deve ter exatamente 8 dígitos.",
    );
  });

  it("should accept CEP with formatting and remove non-numeric characters", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      cep: "12345-678",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.cep).toBe("12345678");
  });

  it("should accept empty CEP as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      cep: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if the city is too short", () => {
    const payload = {
      city: "A",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().city?._errors).toContain(
      "A cidade deve ter no mínimo 2 caracteres.",
    );
  });

  it("should fail if the city exceeds 100 characters", () => {
    const payload = {
      city: "a".repeat(101),
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().city?._errors).toContain(
      "A cidade deve ter no máximo 100 caracteres.",
    );
  });

  it("should fail if the city contains consecutive spaces", () => {
    const payload = {
      city: "São  Paulo",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().city?._errors).toContain(
      "O nome da cidade não deve conter espaços consecutivos.",
    );
  });

  it("should fail if UF is not exactly 2 characters", () => {
    const payload = {
      uf: "SPP",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().uf?._errors).toContain(
      "UF deve ter exatamente 2 caracteres.",
    );
  });

  it("should convert UF to uppercase", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      uf: "rj",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.uf).toBe("RJ");
  });

  it("should fail if UF contains numbers", () => {
    const payload = {
      uf: "S1",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().uf?._errors).toContain(
      "O UF deve conter apenas letras sem números, símbolos ou traços.",
    );
  });

  it("should fail if the street is too short", () => {
    const payload = {
      street: "Ab",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().street?._errors).toContain(
      "O nome da rua deve ter no mínimo 3 caracteres.",
    );
  });

  it("should fail if the street exceeds 100 characters", () => {
    const payload = {
      street: "a".repeat(101),
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().street?._errors).toContain(
      "O nome da rua deve ter no máximo 100 caracteres.",
    );
  });

  it("should accept empty street as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      street: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid address_number with letter", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      address_number: "456B",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if address_number exceeds 10 characters", () => {
    const payload = {
      address_number: "12345678901",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().address_number?._errors).toContain(
      "O número do endereço deve ter no máximo 10 caracteres.",
    );
  });

  it("should fail if address_number has invalid format", () => {
    const payload = {
      address_number: "A456",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().address_number?._errors).toContain(
      "O número do endereço deve conter apenas números e letras.",
    );
  });

  it("should accept empty address_number as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      address_number: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if complement exceeds 50 characters", () => {
    const payload = {
      complement: "a".repeat(51),
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().complement?._errors).toContain(
      "O complemento deve ter no máximo 50 caracteres.",
    );
  });

  it("should accept valid complement", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      complement: "Sala 456",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept empty complement as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      complement: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if telephone is invalid (too short)", () => {
    const payload = {
      telephone: "123456789",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().telephone?._errors).toContain(
      "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
    );
  });

  it("should fail if telephone is invalid (too long)", () => {
    const payload = {
      telephone: "123456789012",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().telephone?._errors).toContain(
      "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
    );
  });

  it("should accept valid telephone with 10 digits", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      telephone: "1123456789",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept valid telephone with 11 digits", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      telephone: "11987654321",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept telephone with formatting and remove non-numeric characters", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      telephone: "(11) 98765-4321",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.telephone).toBe("11987654321");
  });

  it("should accept empty telephone as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      telephone: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail if email is invalid", () => {
    const payload = {
      email: "invalid-email",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail informado não é válido.",
    );
  });

  it("should fail if email exceeds 100 characters", () => {
    const payload = {
      email: "a".repeat(95) + "@ex.com",
    };

    const result = updateSupplierSchema.safeParse(payload);

    expect(result.success).toBe(false);
    expect(result.error?.format().email?._errors).toContain(
      "O e-mail deve ter no máximo 100 caracteres.",
    );
  });

  it("should accept valid email", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      email: "fornecedor@atualizado.com",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should accept empty email as null", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      email: "",
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("should fail for empty object since name and cnpj are required", () => {
    const payload = {};

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("should accept null values for optional fields", () => {
    const payload = {
      name: "Fornecedor Teste",
      cnpj: "12345678000100",
      email: null,
      cep: null,
      city: null,
      uf: null,
      street: null,
      address_number: null,
      complement: null,
      telephone: null,
    };

    const result = updateSupplierSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
