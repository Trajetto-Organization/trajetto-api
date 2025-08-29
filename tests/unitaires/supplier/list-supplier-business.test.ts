import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListSupplierBusinessUseCase } from "@/modules/supplier/usecases/list-supplier-business/list-supplier-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Supplier Business UseCase", () => {
  let supplierInMemory: InMemorySupplierRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listSupplierBusinessUseCase: ListSupplierBusinessUseCase;

  beforeEach(() => {
    supplierInMemory = new InMemorySupplierRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listSupplierBusinessUseCase = new ListSupplierBusinessUseCase(
      userInMemory,
      supplierInMemory,
      businessInMemory,
    );
  });

  it("should be able to list suppliers for a specific business", async () => {
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

    const result = await listSupplierBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].name).toBe("Fornecedor Alpha");
    expect(result.data[1].name).toBe("Fornecedor Beta");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listSupplierBusinessUseCase.execute(
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
      listSupplierBusinessUseCase.execute(
        user.id,
        1,
        10,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should return empty list when no suppliers exist for the specific business", async () => {
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

    const result = await listSupplierBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only suppliers from the specified business", async () => {
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

    const supplier1Data = {
      name: "Fornecedor Business 1",
      cnpj: "11111111000111",
      businessId: business1.id as string,
    };

    const supplier2Data = {
      name: "Fornecedor Business 2A",
      cnpj: "22222222000222",
      businessId: business2.id as string,
    };

    const supplier3Data = {
      name: "Fornecedor Business 2B",
      cnpj: "33333333000333",
      businessId: business2.id as string,
    };

    await supplierInMemory.createSupplier(supplier1Data);
    await supplierInMemory.createSupplier(supplier2Data);
    await supplierInMemory.createSupplier(supplier3Data);

    const result = await listSupplierBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.data[0].name).toBe("Fornecedor Business 2A");
    expect(result.data[1].name).toBe("Fornecedor Business 2B");
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

    for (let i = 1; i <= 5; i++) {
      const supplierData = {
        name: `Fornecedor ${i}`,
        cnpj: `${i.toString().padStart(11, "0")}000111`,
        businessId: business.id as string,
      };
      await supplierInMemory.createSupplier(supplierData);
    }

    const page1Result = await listSupplierBusinessUseCase.execute(
      user.id,
      1,
      2,
      business.id as string,
    );
    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);
    expect(page1Result.data[0].name).toBe("Fornecedor 1");
    expect(page1Result.data[1].name).toBe("Fornecedor 2");

    const page2Result = await listSupplierBusinessUseCase.execute(
      user.id,
      2,
      2,
      business.id as string,
    );
    expect(page2Result.data).toHaveLength(2);
    expect(page2Result.total).toBe(5);
    expect(page2Result.data[0].name).toBe("Fornecedor 3");
    expect(page2Result.data[1].name).toBe("Fornecedor 4");

    const page3Result = await listSupplierBusinessUseCase.execute(
      user.id,
      3,
      2,
      business.id as string,
    );
    expect(page3Result.data).toHaveLength(1);
    expect(page3Result.total).toBe(5);
    expect(page3Result.data[0].name).toBe("Fornecedor 5");
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

    const supplierData = {
      name: "Single Fornecedor",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplierData);

    const result = await listSupplierBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].name).toBe("Single Fornecedor");
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

    const supplierData = {
      name: "Single Fornecedor",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplierData);

    const result = await listSupplierBusinessUseCase.execute(
      user.id,
      5,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(1);
  });

  it("should throw an AppError if an error occurs while listing suppliers", async () => {
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

    vi.spyOn(supplierInMemory, "listSupplierBusiness").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      listSupplierBusinessUseCase.execute(
        user.id,
        1,
        10,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível recuperar a lista de fornecedores por empresa!",
        500,
      ),
    );
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

    const supplierData = {
      name: "Test Fornecedor",
      cnpj: "11111111000111",
      businessId: business.id as string,
    };

    await supplierInMemory.createSupplier(supplierData);

    const masterResult = await listSupplierBusinessUseCase.execute(
      masterUser.id,
      1,
      10,
      business.id as string,
    );

    expect(masterResult.data).toHaveLength(1);
    expect(masterResult.data[0].name).toBe("Test Fornecedor");

    const businessResult = await listSupplierBusinessUseCase.execute(
      businessUser.id,
      1,
      10,
      business.id as string,
    );

    expect(businessResult.data).toHaveLength(1);
    expect(businessResult.data[0].name).toBe("Test Fornecedor");
  });
});
