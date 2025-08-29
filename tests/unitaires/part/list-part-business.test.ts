import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListPartBusinessUseCase } from "@/modules/part/usecases/list-part-business/list-part-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Part Business UseCase", () => {
  let partInMemory: InMemoryPartRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listPartBusinessUseCase: ListPartBusinessUseCase;

  beforeEach(() => {
    partInMemory = new InMemoryPartRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listPartBusinessUseCase = new ListPartBusinessUseCase(
      userInMemory,
      partInMemory,
      businessInMemory,
    );
  });

  it("should be able to list parts for a specific business", async () => {
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

    const result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Filtro de Óleo");
    expect(result.data[1].description).toBe("Vela de Ignição");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listPartBusinessUseCase.execute(
        "non-existent-user-id",
        1,
        10,
        "business-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business is not found", async () => {
    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: "business-id",
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    await expect(
      listPartBusinessUseCase.execute(
        user.id,
        1,
        10,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should return empty list when no parts exist for the specific business", async () => {
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

    const result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only parts from the specified business", async () => {
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
      role: "MASTER" as UserRole,
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
      description: "Peça Business 2A",
      unit_price: 35.99,
      businessId: business2.id as string,
    };

    const part3Data = {
      description: "Peça Business 2B",
      unit_price: 45.99,
      businessId: business2.id as string,
    };

    await partInMemory.createPart(part1Data);
    await partInMemory.createPart(part2Data);
    await partInMemory.createPart(part3Data);

    const result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Peça Business 2A");
    expect(result.data[1].description).toBe("Peça Business 2B");

    expect(result.data[0].businessId).toBe(business2.id);
    expect(result.data[1].businessId).toBe(business2.id);
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
    const page1Result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      2,
      business.id as string,
    );

    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);

    expect(page1Result.data[0].description).toBe("Peça 1");
    expect(page1Result.data[1].description).toBe("Peça 2");

    // Test page 2
    const page2Result = await listPartBusinessUseCase.execute(
      user.id,
      2,
      2,
      business.id as string,
    );

    expect(page2Result.data).toHaveLength(2);
    expect(page2Result.total).toBe(5);

    expect(page2Result.data[0].description).toBe("Peça 3");
    expect(page2Result.data[1].description).toBe("Peça 4");

    // Test page 3
    const page3Result = await listPartBusinessUseCase.execute(
      user.id,
      3,
      2,
      business.id as string,
    );

    expect(page3Result.data).toHaveLength(1);
    expect(page3Result.total).toBe(5);

    expect(page3Result.data[0].description).toBe("Peça 5");
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

    const result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

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

    const result = await listPartBusinessUseCase.execute(
      user.id,
      5,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(1);
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
    const masterResult = await listPartBusinessUseCase.execute(
      masterUser.id,
      1,
      10,
      business.id as string,
    );

    expect(masterResult.data).toHaveLength(1);
    expect(masterResult.data[0].description).toBe("Peça Teste");

    // Test with BUSINESS_USER
    const businessResult = await listPartBusinessUseCase.execute(
      businessUser.id,
      1,
      10,
      business.id as string,
    );

    expect(businessResult.data).toHaveLength(1);
    expect(businessResult.data[0].description).toBe("Peça Teste");
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

    const result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

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

  it("should handle multiple businesses with mixed parts correctly", async () => {
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
      role: "MASTER" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    // Create many parts for different businesses
    for (let i = 1; i <= 10; i++) {
      const businessId = i <= 3 ? business1.id : business2.id;
      const partData = {
        description: `Peça ${i}`,
        unit_price: 10.0 + i,
        businessId: businessId as string,
      };
      await partInMemory.createPart(partData);
    }

    // List parts only for business1 (should have 3 parts)
    const business1Result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business1.id as string,
    );

    expect(business1Result.data).toHaveLength(3);
    expect(business1Result.total).toBe(3);

    expect(business1Result.data[0].description).toBe("Peça 1");
    expect(business1Result.data[1].description).toBe("Peça 2");

    expect(business1Result.data[2].description).toBe("Peça 3");

    // List parts only for business2 (should have 7 parts)
    const business2Result = await listPartBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(business2Result.data).toHaveLength(7);
    expect(business2Result.total).toBe(7);

    expect(business2Result.data[0].description).toBe("Peça 4");
    expect(business2Result.data[6].description).toBe("Peça 10");
  });

  it("should throw an AppError if an error occurs while listing parts", async () => {
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

    vi.spyOn(partInMemory, "listPartBusiness").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      listPartBusinessUseCase.execute(user.id, 1, 10, business.id as string),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível recuperar a lista de peças por empresa!",
        500,
      ),
    );
  });

  it("should handle large pagination correctly", async () => {
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

    // Create 100 parts
    for (let i = 1; i <= 100; i++) {
      const partData = {
        description: `Peça ${i.toString().padStart(3, "0")}`,
        unit_price: 10.0 + i / 100,
        businessId: business.id as string,
      };
      await partInMemory.createPart(partData);
    }

    // Test first page
    const firstPageResult = await listPartBusinessUseCase.execute(
      user.id,
      1,
      20,
      business.id as string,
    );

    expect(firstPageResult.data).toHaveLength(20);
    expect(firstPageResult.total).toBe(100);

    expect(firstPageResult.data[0].description).toBe("Peça 001");
    expect(firstPageResult.data[19].description).toBe("Peça 020");

    // Test middle page
    const middlePageResult = await listPartBusinessUseCase.execute(
      user.id,
      3,
      20,
      business.id as string,
    );

    expect(middlePageResult.data).toHaveLength(20);
    expect(middlePageResult.total).toBe(100);

    expect(middlePageResult.data[0].description).toBe("Peça 041");
    expect(middlePageResult.data[19].description).toBe("Peça 060");

    // Test last page
    const lastPageResult = await listPartBusinessUseCase.execute(
      user.id,
      5,
      20,
      business.id as string,
    );

    expect(lastPageResult.data).toHaveLength(20);
    expect(lastPageResult.total).toBe(100);

    expect(lastPageResult.data[0].description).toBe("Peça 081");
    expect(lastPageResult.data[19].description).toBe("Peça 100");
  });
});
