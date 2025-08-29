import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListPartUseCase } from "@/modules/part/usecases/list-part/list-part-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Part UseCase", () => {
  let partInMemory: InMemoryPartRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listPartUseCase: ListPartUseCase;

  beforeEach(() => {
    partInMemory = new InMemoryPartRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listPartUseCase = new ListPartUseCase(userInMemory, partInMemory);
  });

  it("should be able to list parts for a business", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const part1Data = {
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part2Data = {
      description: "Vela de Ignição",
      unit_price: 45.5,
      businessId: business.id as string,
    };

    await partInMemory.createPart(part1Data);
    await partInMemory.createPart(part2Data);

    const result = await listPartUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Filtro de Óleo");
    expect(result.data[1].description).toBe("Vela de Ignição");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listPartUseCase.execute("non-existent-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should return empty list when no parts exist for business", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);
    const result = await listPartUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only parts from user's business", async () => {
    const business1Data = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business2Data = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000111",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "RJ",
      street: "Test Street 2",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Person 2",
      erp_code: "ERP456",
    };

    const business1 = await businessInMemory.createBusiness(business1Data);
    const business2 = await businessInMemory.createBusiness(business2Data);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const part1Data = {
      description: "Peça Business 1",
      unit_price: 25.99,
      businessId: business1.id as string,
    };

    const part2Data = {
      description: "Peça Business 2",
      unit_price: 35.99,
      businessId: business2.id as string,
    };

    await partInMemory.createPart(part1Data);
    await partInMemory.createPart(part2Data);

    const result = await listPartUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Peça Business 1");
    expect(result.data[0].businessId).toBe(business1.id);
  });

  it("should handle pagination correctly", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    // Create 5 parts
    for (let i = 1; i <= 5; i++) {
      const partData = {
        description: `Peça ${i}`,
        unit_price: 10.0 + i,
        businessId: business.id as string,
      };
      await partInMemory.createPart(partData);
    }

    // Test page 1
    const page1Result = await listPartUseCase.execute(user.id, 1, 2);

    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);

    expect(page1Result.data[0].description).toBe("Peça 1");
    expect(page1Result.data[1].description).toBe("Peça 2");

    // Test page 2
    const page2Result = await listPartUseCase.execute(user.id, 2, 2);
    expect(page2Result.data).toHaveLength(2);

    expect(page2Result.total).toBe(5);

    expect(page2Result.data[0].description).toBe("Peça 3");
    expect(page2Result.data[1].description).toBe("Peça 4");

    // Test page 3
    const page3Result = await listPartUseCase.execute(user.id, 3, 2);
    expect(page3Result.data).toHaveLength(1);

    expect(page3Result.total).toBe(5);
    expect(page3Result.data[0].description).toBe("Peça 5");
  });

  it("should filter parts by search term", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const part1Data = {
      description: "Filtro de Óleo",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    const part2Data = {
      description: "Vela de Ignição",
      unit_price: 45.5,
      businessId: business.id as string,
    };

    const part3Data = {
      description: "Filtro de Ar",
      unit_price: 15.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(part1Data);
    await partInMemory.createPart(part2Data);

    await partInMemory.createPart(part3Data);

    // Search for "Filtro"
    const searchResult = await listPartUseCase.execute(
      user.id,
      1,
      10,
      "Filtro",
    );

    expect(searchResult.data).toHaveLength(2);
    expect(searchResult.total).toBe(2);

    expect(searchResult.data[0].description).toBe("Filtro de Óleo");
    expect(searchResult.data[1].description).toBe("Filtro de Ar");

    // Search for "Vela"
    const searchVelaResult = await listPartUseCase.execute(
      user.id,
      1,
      10,
      "Vela",
    );

    expect(searchVelaResult.data).toHaveLength(1);
    expect(searchVelaResult.data[0].description).toBe("Vela de Ignição");

    // Search for non-existent term
    const noResultsResult = await listPartUseCase.execute(
      user.id,
      1,
      10,
      "NonExistent",
    );

    expect(noResultsResult.data).toHaveLength(0);
    expect(noResultsResult.total).toBe(0);
  });

  it("should handle case insensitive search", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "FILTRO DE ÓLEO",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partData);

    // Search lowercase
    const lowercaseResult = await listPartUseCase.execute(
      user.id,
      1,
      10,
      "filtro",
    );

    expect(lowercaseResult.data).toHaveLength(1);
    expect(lowercaseResult.data[0].description).toBe("FILTRO DE ÓLEO");

    // Search mixed case
    const mixedCaseResult = await listPartUseCase.execute(
      user.id,
      1,
      10,
      "Óleo",
    );

    expect(mixedCaseResult.data).toHaveLength(1);
    expect(mixedCaseResult.data[0].description).toBe("FILTRO DE ÓLEO");
  });

  it("should work with different user roles", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const masterUserData = {
      email: "master@example.com",
      password: await hash("password", 6),
      name: "Master User",
      role: "MASTER" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const businessUserData = {
      email: "business@example.com",
      password: await hash("password", 6),
      name: "Business User",
      role: "BUSINESS_USER" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const masterUser = await userInMemory.createUser(masterUserData);
    const businessUser = await userInMemory.createUser(businessUserData);

    const partData = {
      description: "Peça Teste",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partData);

    // Test with MASTER user
    const masterResult = await listPartUseCase.execute(masterUser.id, 1, 10);

    expect(masterResult.data).toHaveLength(1);
    expect(masterResult.data[0].description).toBe("Peça Teste");

    // Test with BUSINESS_USER
    const businessResult = await listPartUseCase.execute(
      businessUser.id,
      1,
      10,
    );

    expect(businessResult.data).toHaveLength(1);
    expect(businessResult.data[0].description).toBe("Peça Teste");
  });

  it("should handle edge case with page size larger than total items", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Única Peça",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partData);

    const result = await listPartUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Única Peça");
  });

  it("should handle edge case with page beyond available items", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Única Peça",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partData);

    const result = await listPartUseCase.execute(user.id, 5, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(1);
  });

  it("should throw an AppError if an error occurs while listing parts", async () => {
    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: "business-id",
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(partInMemory, "listParts").mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(listPartUseCase.execute(user.id, 1, 10)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar listar as peças! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should handle empty search term", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partData = {
      description: "Peça Teste",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partData);

    const result = await listPartUseCase.execute(user.id, 1, 10, "");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Peça Teste");
  });

  it("should list parts with suppliers correctly", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const partWithSupplierData = {
      description: "Peça Com Fornecedor",
      unit_price: 35.99,
      businessId: business.id as string,
      supplierId: "supplier-123",
    };

    const partWithoutSupplierData = {
      description: "Peça Sem Fornecedor",
      unit_price: 25.99,
      businessId: business.id as string,
    };

    await partInMemory.createPart(partWithSupplierData);
    await partInMemory.createPart(partWithoutSupplierData);

    const result = await listPartUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    const partWithSupplier = result.data.find(
      (p) => p.description === "Peça Com Fornecedor",
    );
    const partWithoutSupplier = result.data.find(
      (p) => p.description === "Peça Sem Fornecedor",
    );

    expect(partWithSupplier?.supplierId).toBe("supplier-123");
    expect(partWithoutSupplier?.supplierId).toBeNull();
  });
});
