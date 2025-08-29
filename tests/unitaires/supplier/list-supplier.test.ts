import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListSupplierUseCase } from "@/modules/supplier/usecases/list-supplier/list-supplier-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Supplier UseCase", () => {
  let supplierInMemory: InMemorySupplierRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listSupplierUseCase: ListSupplierUseCase;

  beforeEach(() => {
    supplierInMemory = new InMemorySupplierRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listSupplierUseCase = new ListSupplierUseCase(
      userInMemory,
      supplierInMemory,
    );
  });

  it("should be able to list suppliers for a business", async () => {
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

    const supplier1Data = {
      name: "Fornecedor Alpha",
      cnpj: "11111111000111",
      email: "alpha@example.com",
      businessId: business.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor Beta",
      cnpj: "22222222000222",
      email: "beta@example.com",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    await supplierInMemory.createSupplier(supplier2Data);

    const result = await listSupplierUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].name).toBe("Fornecedor Alpha");
    expect(result.data[1].name).toBe("Fornecedor Beta");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listSupplierUseCase.execute("non-existent-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should return empty list when no suppliers exist for business", async () => {
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
    const result = await listSupplierUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only suppliers from user's business", async () => {
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

    const supplier1Data = {
      name: "Fornecedor Business 1",
      cnpj: "11111111000111",
      businessId: business1.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor Business 2",
      cnpj: "22222222000222",
      businessId: business2.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    await supplierInMemory.createSupplier(supplier2Data);

    const result = await listSupplierUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].name).toBe("Fornecedor Business 1");
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

    for (let i = 1; i <= 5; i++) {
      const supplierData = {
        name: `Fornecedor ${i}`,
        cnpj: `${i.toString().padStart(11, "0")}000111`,
        businessId: business.id as string,
      };
      await supplierInMemory.createSupplier(supplierData);
    }

    const page1Result = await listSupplierUseCase.execute(user.id, 1, 2);

    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);

    expect(page1Result.data[0].name).toBe("Fornecedor 1");
    expect(page1Result.data[1].name).toBe("Fornecedor 2");

    const page2Result = await listSupplierUseCase.execute(user.id, 2, 2);

    expect(page2Result.data).toHaveLength(2);
    expect(page2Result.total).toBe(5);

    expect(page2Result.data[0].name).toBe("Fornecedor 3");
    expect(page2Result.data[1].name).toBe("Fornecedor 4");

    const page3Result = await listSupplierUseCase.execute(user.id, 3, 2);

    expect(page3Result.data).toHaveLength(1);
    expect(page3Result.total).toBe(5);

    expect(page3Result.data[0].name).toBe("Fornecedor 5");
  });

  it("should filter suppliers by search term", async () => {
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

    const supplier1Data = {
      name: "Alpha Fornecedor",
      cnpj: "11111111000111",
      email: "alpha@example.com",
      businessId: business.id as string,
    };

    const supplier2Data = {
      name: "Beta Empresa",
      cnpj: "22222222000222",
      email: "beta@example.com",
      businessId: business.id as string,
    };

    const supplier3Data = {
      name: "Gamma Corporation",
      cnpj: "33333333000333",
      email: "gamma@example.com",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    await supplierInMemory.createSupplier(supplier2Data);

    await supplierInMemory.createSupplier(supplier3Data);

    const searchByNameResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "Alpha",
    );
    expect(searchByNameResult.data).toHaveLength(1);
    expect(searchByNameResult.data[0].name).toBe("Alpha Fornecedor");

    const searchByCnpjResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "22222222000222",
    );
    expect(searchByCnpjResult.data).toHaveLength(1);
    expect(searchByCnpjResult.data[0].name).toBe("Beta Empresa");

    const searchByEmailResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "gamma@example.com",
    );
    expect(searchByEmailResult.data).toHaveLength(1);
    expect(searchByEmailResult.data[0].name).toBe("Gamma Corporation");

    const searchNoResultsResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "NonExistent",
    );

    expect(searchNoResultsResult.data).toHaveLength(0);
    expect(searchNoResultsResult.total).toBe(0);
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

    const supplierData = {
      name: "Alpha Fornecedor",
      cnpj: "11111111000111",
      email: "Alpha@Example.COM",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplierData);
    const searchLowercaseResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "alpha",
    );

    expect(searchLowercaseResult.data).toHaveLength(1);
    expect(searchLowercaseResult.data[0].name).toBe("Alpha Fornecedor");

    const searchUppercaseResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "ALPHA",
    );

    expect(searchUppercaseResult.data).toHaveLength(1);
    expect(searchUppercaseResult.data[0].name).toBe("Alpha Fornecedor");

    const searchEmailResult = await listSupplierUseCase.execute(
      user.id,
      1,
      10,
      "alpha@example.com",
    );

    expect(searchEmailResult.data).toHaveLength(1);
    expect(searchEmailResult.data[0].name).toBe("Alpha Fornecedor");
  });

  it("should throw an AppError if an error occurs while listing suppliers", async () => {
    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: "business-id",
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(supplierInMemory, "listAllSuppliers").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(listSupplierUseCase.execute(user.id, 1, 10)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar listar os fornecedores! Por favor, tente novamente.",
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

    const supplierData = {
      name: "Test Fornecedor",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplierData);

    const result = await listSupplierUseCase.execute(user.id, 1, 10, "");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].name).toBe("Test Fornecedor");
  });
});
