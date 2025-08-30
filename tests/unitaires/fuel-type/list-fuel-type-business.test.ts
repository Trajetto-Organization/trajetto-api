import { describe, it, expect, beforeEach, vi } from "vitest";
import { ListFuelTypeBusinessUseCase } from "@/modules/fuel-type/usecases/list-fuel-type-business/fuel-type-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Fuel Type Business UseCase", () => {
  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listFuelTypeBusinessUseCase: ListFuelTypeBusinessUseCase;

  beforeEach(() => {
    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listFuelTypeBusinessUseCase = new ListFuelTypeBusinessUseCase(
      userInMemory,
      fuelTypeInMemory,
      businessInMemory,
    );
  });

  it("should be able to list fuel types for a specific business", async () => {
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

    const fuelTypes = ["Diesel S10", "Gasolina Comum", "Etanol", "GNV"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    const result = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(4);
    expect(result.total).toBe(4);

    expect(result.data.map((ft) => ft.description)).toEqual(
      expect.arrayContaining(fuelTypes),
    );
    expect(result.data.every((ft) => ft.businessId === business.id)).toBe(true);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
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

    await expect(
      listFuelTypeBusinessUseCase.execute(
        "non-existent-user-id",
        1,
        10,
        business.id as string,
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
      listFuelTypeBusinessUseCase.execute(
        user.id,
        1,
        10,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should return empty list when business has no fuel types", async () => {
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

    const result = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
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

    const fuelTypes = [
      "Diesel S10",
      "Diesel Comum",
      "Gasolina Comum",
      "Gasolina Aditivada",
      "Etanol",
      "GNV",
      "Biodiesel B5",
      "Biodiesel B10",
      "Arla-32",
    ];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // First page
    const page1 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      4,
      business.id as string,
    );

    expect(page1.data).toHaveLength(4);
    expect(page1.total).toBe(9);

    // Second page
    const page2 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      2,
      4,
      business.id as string,
    );

    expect(page2.data).toHaveLength(4);
    expect(page2.total).toBe(9);

    // Third page (partial)
    const page3 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      3,
      4,
      business.id as string,
    );

    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(9);

    // Fourth page (empty)
    const page4 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      4,
      4,
      business.id as string,
    );

    expect(page4.data).toHaveLength(0);
    expect(page4.total).toBe(9);
  });

  it("should only list fuel types for the specified business", async () => {
    const businessData1 = {
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

    const businessData2 = {
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

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    // Create fuel types for both businesses
    await fuelTypeInMemory.createFuelType({
      description: "Diesel Business 1",
      businessId: business1.id as string,
    });

    await fuelTypeInMemory.createFuelType({
      description: "Gasolina Business 1",
      businessId: business1.id as string,
    });

    await fuelTypeInMemory.createFuelType({
      description: "Diesel Business 2",
      businessId: business2.id as string,
    });

    await fuelTypeInMemory.createFuelType({
      description: "Etanol Business 2",
      businessId: business2.id as string,
    });

    // Request fuel types for business1
    const result1 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business1.id as string,
    );

    expect(result1.data).toHaveLength(2);
    expect(result1.total).toBe(2);

    expect(result1.data.every((ft) => ft.businessId === business1.id)).toBe(
      true,
    );
    expect(
      result1.data.some((ft) => ft.description === "Diesel Business 1"),
    ).toBe(true);

    expect(
      result1.data.some((ft) => ft.description === "Gasolina Business 1"),
    ).toBe(true);

    // Request fuel types for business2
    const result2 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(result2.data).toHaveLength(2);
    expect(result2.total).toBe(2);

    expect(result2.data.every((ft) => ft.businessId === business2.id)).toBe(
      true,
    );
    expect(
      result2.data.some((ft) => ft.description === "Diesel Business 2"),
    ).toBe(true);

    expect(
      result2.data.some((ft) => ft.description === "Etanol Business 2"),
    ).toBe(true);
  });

  it("should work with MASTER user accessing any business", async () => {
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
      businessId: "",
      profileAccessId: "profile-1",
    };

    const masterUser = await userInMemory.createUser(masterUserData);

    const fuelTypes = ["Diesel MASTER", "Gasolina MASTER"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    const result = await listFuelTypeBusinessUseCase.execute(
      masterUser.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data.every((ft) => ft.businessId === business.id)).toBe(true);
    expect(result.data.some((ft) => ft.description === "Diesel MASTER")).toBe(
      true,
    );

    expect(result.data.some((ft) => ft.description === "Gasolina MASTER")).toBe(
      true,
    );
  });

  it("should work with BUSINESS_USER accessing their business", async () => {
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

    const businessUserData = {
      email: "businessuser@example.com",
      password: await hash("password", 6),
      name: "Business User",
      role: "BUSINESS_USER" as UserRole,
      businessId: business.id as string,
      profileAccessId: "profile-1",
    };

    const businessUser = await userInMemory.createUser(businessUserData);

    const fuelTypes = ["Diesel USER", "Gasolina USER"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    const result = await listFuelTypeBusinessUseCase.execute(
      businessUser.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data.every((ft) => ft.businessId === business.id)).toBe(true);
    expect(result.data.some((ft) => ft.description === "Diesel USER")).toBe(
      true,
    );

    expect(result.data.some((ft) => ft.description === "Gasolina USER")).toBe(
      true,
    );
  });

  it("should handle edge cases with page size", async () => {
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

    const fuelTypes = ["Diesel", "Gasolina", "Etanol", "GNV"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // Test with page size 1
    const result1 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      1,
      business.id as string,
    );

    expect(result1.data).toHaveLength(1);
    expect(result1.total).toBe(4);

    // Test with large page size
    const result100 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      100,
      business.id as string,
    );

    expect(result100.data).toHaveLength(4);
    expect(result100.total).toBe(4);
  });

  it("should throw an AppError if an error occurs while listing fuel types by business", async () => {
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

    vi.spyOn(fuelTypeInMemory, "listFuelTypeBusiness").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      listFuelTypeBusinessUseCase.execute(
        user.id,
        1,
        10,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível recuperar a lista de combustíveis por empresa!",
        500,
      ),
    );
  });

  it("should preserve fuel type properties in response", async () => {
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

    await fuelTypeInMemory.createFuelType({
      description: "Diesel Test Business",
      businessId: business.id as string,
    });

    const result = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(1);
    const fuelType = result.data[0];

    expect(fuelType).toHaveProperty("id");
    expect(fuelType).toHaveProperty("description");

    expect(fuelType).toHaveProperty("businessId");
    expect(fuelType).toHaveProperty("created_at");

    expect(fuelType).toHaveProperty("updated_at");
    expect(fuelType.description).toBe("Diesel Test Business");

    expect(fuelType.businessId).toBe(business.id);
  });

  it("should handle multiple businesses with same fuel type descriptions", async () => {
    const businessData1 = {
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

    const businessData2 = {
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

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    // Create same fuel type descriptions in both businesses
    const sharedFuelTypes = ["Diesel S10", "Gasolina Comum"];

    for (const description of sharedFuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business1.id as string,
      });

      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business2.id as string,
      });
    }

    // Request fuel types for business1 - should only get business1's fuel types
    const result1 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business1.id as string,
    );

    expect(result1.data).toHaveLength(2);
    expect(result1.total).toBe(2);

    expect(result1.data.every((ft) => ft.businessId === business1.id)).toBe(
      true,
    );

    // Request fuel types for business2 - should only get business2's fuel types
    const result2 = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(result2.data).toHaveLength(2);
    expect(result2.total).toBe(2);

    expect(result2.data.every((ft) => ft.businessId === business2.id)).toBe(
      true,
    );
  });

  it("should handle zero results gracefully", async () => {
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

    // Don't create any fuel types for this business

    const result = await listFuelTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);

    expect(result.data).toEqual([]);
  });
});
