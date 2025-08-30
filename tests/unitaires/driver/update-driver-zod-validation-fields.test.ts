import { describe, it, expect } from "vitest";
import { updateDriverSchema } from "../../../src/schemas/update-driver-schema";

describe("Update Driver Schema Validation", () => {
  describe("Complete schema validation", () => {
    it("should accept valid complete data", () => {
      const data = {
        name: "João Silva Santos",
        birth_date: "1990-05-15",
        cnh: "12345678901",
        cpf: "12345678901",
        rg: "123456789",
        cep: "12345678",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Flores",
        address_number: "123",
        complement: "Apartamento 10",
        status: "ACTIVE",
        contract_type: "OWNED",
        branchId: "123e4567-e89b-12d3-a456-426614174000",
      };

      const result = updateDriverSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("should accept partial data with only birth_date (required field)", () => {
      const data = {
        birth_date: "1990-05-15",
      };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject empty object", () => {
      const data = {};
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
    });
  });

  describe("name field validation", () => {
    it("should accept valid name when provided", () => {
      const data = { name: "João Silva Santos", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when name is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject name with less than 3 characters", () => {
      const data = { name: "Jo", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome deve ter no mínimo 3 caracteres.",
      );
    });

    it("should reject name with more than 100 characters", () => {
      const data = { name: "a".repeat(101), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome deve ter no máximo 100 caracteres.",
      );
    });

    it("should reject name with consecutive spaces", () => {
      const data = { name: "João  Silva", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome não deve conter espaços consecutivos.",
      );
    });

    it("should reject name starting with space", () => {
      const data = { name: " João Silva", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should reject name ending with space", () => {
      const data = { name: "João Silva ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should reject name with single word", () => {
      const data = { name: "João", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "Por favor, insira o nome completo.",
      );
    });

    it("should reject name starting with symbol", () => {
      const data = { name: "@João Silva", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
      );
    });

    it("should reject name ending with symbol", () => {
      const data = { name: "João Silva@", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
      );
    });

    it("should accept name with symbols in middle", () => {
      const data = { name: "João-Silva Santos", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });
  });

  describe("birth_date field validation", () => {
    it("should accept valid birth date", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject missing birth_date (required field)", () => {
      const data = { name: "João Silva" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it("should reject invalid date string", () => {
      const data = { birth_date: "invalid-date" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "Data de nascimento inválida.",
      );
    });

    it("should reject birth date for minor (under 18)", () => {
      const currentYear = new Date().getFullYear();
      const minorYear = currentYear - 17;

      const data = { birth_date: `${minorYear}-01-01` };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O motorista deve ter pelo menos 18 anos.",
      );
    });

    it("should accept birth date for adult (18 or older)", () => {
      const currentYear = new Date().getFullYear();
      const adultYear = currentYear - 18;

      const data = { birth_date: `${adultYear}-01-01` };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });
  });

  describe("cnh field validation", () => {
    it("should accept valid CNH when provided", () => {
      const data = { cnh: "12345678901", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when cnh is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject CNH with more than 20 characters", () => {
      const data = { cnh: "a".repeat(21), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O número da CNH deve ter no máximo 20 caracteres.",
      );
    });
  });

  describe("cpf field validation", () => {
    it("should accept valid CPF with 11 digits when provided", () => {
      const data = { cpf: "12345678901", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when cpf is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should format CPF by removing non-digit characters", () => {
      const data = { cpf: "123.456.789-01", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.cpf).toBe("12345678901");
    });

    it("should reject CPF with less than 11 digits", () => {
      const data = { cpf: "1234567890", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CPF deve ter exatamente 11 dígitos.",
      );
    });

    it("should reject CPF with more than 11 digits", () => {
      const data = { cpf: "123456789012", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CPF deve ter exatamente 11 dígitos.",
      );
    });

    it("should reject CPF with non-numeric characters after preprocessing", () => {
      const data = { cpf: "1234567890a", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CPF deve ter exatamente 11 dígitos.",
      );
    });
  });

  describe("rg field validation", () => {
    it("should accept valid RG when provided", () => {
      const data = { rg: "123456789", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when rg is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject RG with more than 20 characters", () => {
      const data = { rg: "a".repeat(21), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O número do RG deve ter no máximo 20 caracteres.",
      );
    });
  });

  describe("cep field validation", () => {
    it("should accept valid CEP with 8 digits when provided", () => {
      const data = { cep: "12345678", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when cep is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should format CEP by removing non-digit characters", () => {
      const data = { cep: "12345-678", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.cep).toBe("12345678");
    });

    it("should reject CEP with less than 8 digits", () => {
      const data = { cep: "1234567", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CEP deve ter exatamente 8 dígitos.",
      );
    });

    it("should reject CEP with more than 8 digits", () => {
      const data = { cep: "123456789", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CEP deve ter exatamente 8 dígitos.",
      );
    });

    it("should reject CEP with non-numeric characters after preprocessing", () => {
      const data = { cep: "1234567a", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O CEP deve ter exatamente 8 dígitos.",
      );
    });
  });

  describe("city field validation", () => {
    it("should accept valid city name when provided", () => {
      const data = { city: "São Paulo", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when city is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject city with less than 2 characters", () => {
      const data = { city: "S", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "A cidade deve ter no mínimo 2 caracteres.",
      );
    });

    it("should reject city with more than 100 characters", () => {
      const data = { city: "a".repeat(101), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "A cidade deve ter no máximo 100 caracteres.",
      );
    });

    it("should reject city that is empty or whitespace only", () => {
      const data = { city: "   ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da cidade não pode ser vazio ou conter apenas espaços.",
      );
    });

    it("should reject city with consecutive spaces", () => {
      const data = { city: "São  Paulo", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da cidade não deve conter espaços consecutivos.",
      );
    });

    it("should reject city starting with space", () => {
      const data = { city: " São Paulo", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da cidade não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should reject city ending with space", () => {
      const data = { city: "São Paulo ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da cidade não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should accept city with dash", () => {
      const data = { city: "Rio-Grande", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject city with invalid characters", () => {
      const data = { city: "São Paulo@", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da cidade deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
      );
    });
  });

  describe("uf field validation", () => {
    it("should accept valid UF when provided", () => {
      const data = { uf: "SP", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.uf).toBe("SP");
    });

    it("should accept when uf is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should convert lowercase to uppercase", () => {
      const data = { uf: "sp", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.uf).toBe("SP");
    });

    it("should reject UF with less than 2 characters", () => {
      const data = { uf: "S", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "UF deve ter exatamente 2 caracteres.",
      );
    });

    it("should reject UF with more than 2 characters", () => {
      const data = { uf: "SPP", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "UF deve ter exatamente 2 caracteres.",
      );
    });

    it("should reject UF with consecutive spaces", () => {
      const data = { uf: "S  P", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "UF deve ter exatamente 2 caracteres.",
      );
    });

    it("should reject UF starting with space", () => {
      const data = { uf: " SP", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "UF deve ter exatamente 2 caracteres.",
      );
    });

    it("should reject UF ending with space", () => {
      const data = { uf: "SP ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "UF deve ter exatamente 2 caracteres.",
      );
    });

    it("should reject UF with numbers", () => {
      const data = { uf: "S1", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O UF deve conter apenas letras sem números, símbolos ou traços.",
      );
    });

    it("should reject UF with symbols", () => {
      const data = { uf: "S-", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O UF deve conter apenas letras sem números, símbolos ou traços.",
      );
    });
  });

  describe("street field validation", () => {
    it("should accept valid street name when provided", () => {
      const data = { street: "Rua das Flores", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when street is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject street with less than 3 characters", () => {
      const data = { street: "Ru", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua deve ter no mínimo 3 caracteres.",
      );
    });

    it("should reject street with more than 100 characters", () => {
      const data = { street: "a".repeat(101), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua deve ter no máximo 100 caracteres.",
      );
    });

    it("should reject street that is empty or whitespace only", () => {
      const data = { street: "   ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua não pode ser vazio ou conter apenas espaços.",
      );
    });

    it("should reject street with consecutive spaces", () => {
      const data = { street: "Rua  das Flores", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua não deve conter espaços consecutivos.",
      );
    });

    it("should reject street starting with space", () => {
      const data = { street: " Rua das Flores", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should reject street ending with space", () => {
      const data = { street: "Rua das Flores ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should accept street with dash", () => {
      const data = { street: "Rua-das-Flores", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject street with invalid characters", () => {
      const data = { street: "Rua das Flores@", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome da rua deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
      );
    });
  });

  describe("address_number field validation", () => {
    it("should accept valid address number when provided", () => {
      const data = { address_number: "123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when address_number is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept address number with letter", () => {
      const data = { address_number: "123A", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject address number with more than 10 characters", () => {
      const data = { address_number: "12345678901", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O número do endereço deve ter no máximo 10 caracteres.",
      );
    });

    it("should reject address number with invalid format", () => {
      const data = { address_number: "123@", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O número do endereço deve conter apenas números e letras.",
      );
    });

    it("should reject address number starting with letter", () => {
      const data = { address_number: "A123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O número do endereço deve conter apenas números e letras.",
      );
    });
  });

  describe("complement field validation", () => {
    it("should accept valid complement when provided", () => {
      const data = { complement: "Apartamento 123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when complement is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should convert empty string to null", () => {
      const data = { complement: "", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.complement).toBe(null);
    });

    it("should convert whitespace-only string to null", () => {
      const data = { complement: "   ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.complement).toBe(null);
    });

    it("should reject complement with more than 50 characters", () => {
      const data = { complement: "a".repeat(51), birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O complemento deve ter no máximo 50 caracteres.",
      );
    });

    it("should reject complement with consecutive spaces", () => {
      const data = { complement: "Apartamento  123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome do complemento não deve conter espaços consecutivos.",
      );
    });

    it("should reject complement starting with space", () => {
      const data = { complement: " Apartamento 123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome do complemento não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should reject complement ending with space", () => {
      const data = { complement: "Apartamento 123 ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome do complemento não pode começar ou terminar com espaço em branco.",
      );
    });

    it("should accept complement with dash", () => {
      const data = { complement: "Bloco-A", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject complement with invalid characters", () => {
      const data = { complement: "Apartamento@123", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O nome do complemento deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.",
      );
    });
  });

  describe("status field validation", () => {
    it("should accept ACTIVE status when provided", () => {
      const data = { status: "ACTIVE", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept INACTIVE status when provided", () => {
      const data = { status: "INACTIVE", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when status is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const data = { status: "INVALID", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O status deve ser 'ACTIVE' ou 'INACTIVE'",
      );
    });
  });

  describe("contract_type field validation", () => {
    it("should accept OWNED contract type when provided", () => {
      const data = { contract_type: "OWNED", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept THIRD_PARTY contract type when provided", () => {
      const data = { contract_type: "THIRD_PARTY", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when contract_type is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should reject invalid contract type", () => {
      const data = { contract_type: "INVALID", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O tipo de contrato deve ser 'OWNED' ou 'THIRD_PARTY'",
      );
    });
  });

  describe("branchId field validation", () => {
    it("should accept valid UUID when provided", () => {
      const data = {
        branchId: "123e4567-e89b-12d3-a456-426614174000",
        birth_date: "1990-05-15",
      };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should accept when branchId is not provided (optional)", () => {
      const data = { birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
    });

    it("should convert empty string to null", () => {
      const data = { branchId: "", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.branchId).toBe(null);
    });

    it("should convert whitespace-only string to null", () => {
      const data = { branchId: "   ", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(true);
      expect(result.data?.branchId).toBe(null);
    });

    it("should reject invalid UUID", () => {
      const data = { branchId: "invalid-uuid", birth_date: "1990-05-15" };
      const result = updateDriverSchema.safeParse(data);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(
        "O ID da filial deve ser um UUID válido.",
      );
    });
  });
});
