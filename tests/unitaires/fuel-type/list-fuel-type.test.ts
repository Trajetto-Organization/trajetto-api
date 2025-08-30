import { describe, it, expect, beforeEach, vi } from "vitest";
import { ListFuelTypeUseCase } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Fuel Type UseCase", () => {
  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listFuelTypeUseCase: ListFuelTypeUseCase;

  beforeEach(() => {
    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listFuelTypeUseCase = new ListFuelTypeUseCase(
      userInMemory,
      fuelTypeInMemory,
    );
  });

  it("should be able to list fuel types for a business", async () => {
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

    const fuelTypes = ["Diesel S10", "Gasolina Comum", "Etanol"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    const result = await listFuelTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(3);

    expect(result.data.map((ft) => ft.description)).toEqual(
      expect.arrayContaining(fuelTypes),
    );
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listFuelTypeUseCase.execute("non-existent-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should return empty list when no fuel types exist", async () => {
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

    const result = await listFuelTypeUseCase.execute(user.id, 1, 10);

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
    ];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // First page
    const page1 = await listFuelTypeUseCase.execute(user.id, 1, 3);

    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(7);

    // Second page
    const page2 = await listFuelTypeUseCase.execute(user.id, 2, 3);

    expect(page2.data).toHaveLength(3);
    expect(page2.total).toBe(7);

    // Third page (partial)
    const page3 = await listFuelTypeUseCase.execute(user.id, 3, 3);

    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(7);

    // Fourth page (empty)
    const page4 = await listFuelTypeUseCase.execute(user.id, 4, 3);

    expect(page4.data).toHaveLength(0);
    expect(page4.total).toBe(7);
  });

  it("should handle search functionality", async () => {
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
    ];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // Search for "diesel"
    const dieselResult = await listFuelTypeUseCase.execute(
      user.id,
      1,
      10,
      "diesel",
    );

    expect(dieselResult.data).toHaveLength(3);
    expect(dieselResult.total).toBe(3);

    expect(
      dieselResult.data.every((ft) =>
        ft.description.toLowerCase().includes("diesel"),
      ),
    ).toBe(true);

    // Search for "gasolina"
    const gasolinaResult = await listFuelTypeUseCase.execute(
      user.id,
      1,
      10,
      "gasolina",
    );

    expect(gasolinaResult.data).toHaveLength(2);
    expect(gasolinaResult.total).toBe(2);

    expect(
      gasolinaResult.data.every((ft) =>
        ft.description.toLowerCase().includes("gasolina"),
      ),
    ).toBe(true);

    // Search for "etanol"
    const etanolResult = await listFuelTypeUseCase.execute(
      user.id,
      1,
      10,
      "etanol",
    );

    expect(etanolResult.data).toHaveLength(1);
    expect(etanolResult.total).toBe(1);

    expect(etanolResult.data[0].description).toBe("Etanol");

    // Search for non-existent term
    const noResult = await listFuelTypeUseCase.execute(user.id, 1, 10, "xyz");

    expect(noResult.data).toHaveLength(0);
    expect(noResult.total).toBe(0);
  });

  it("should handle case-insensitive search", async () => {
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
      description: "Diesel S10",
      businessId: business.id as string,
    });

    // Test different case variations
    const searchTerms = ["DIESEL", "diesel", "Diesel", "DIeSeL"];

    for (const searchTerm of searchTerms) {
      const result = await listFuelTypeUseCase.execute(
        user.id,
        1,
        10,
        searchTerm,
      );

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);

      expect(result.data[0].description).toBe("Diesel S10");
    }
  });

  it("should only list fuel types for user's business", async () => {
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

    const result = await listFuelTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data.every((ft) => ft.businessId === business1.id)).toBe(
      true,
    );
    expect(
      result.data.some((ft) => ft.description === "Diesel Business 1"),
    ).toBe(true);

    expect(
      result.data.some((ft) => ft.description === "Gasolina Business 1"),
    ).toBe(true);
    expect(
      result.data.some((ft) => ft.description === "Diesel Business 2"),
    ).toBe(false);
  });

  it("should handle MASTER user role correctly", async () => {
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

    const masterUserData = {
      email: "master@example.com",
      password: await hash("password", 6),
      name: "Master User",
      role: "MASTER" as UserRole,
      businessId: "",
      profileAccessId: "profile-1",
    };

    const masterUser = await userInMemory.createUser(masterUserData);

    // Create fuel types for both businesses
    await fuelTypeInMemory.createFuelType({
      description: "Diesel Business 1",
      businessId: business1.id as string,
    });

    await fuelTypeInMemory.createFuelType({
      description: "Diesel Business 2",
      businessId: business2.id as string,
    });

    const result = await listFuelTypeUseCase.execute(masterUser.id, 1, 10);

    // MASTER user should see all fuel types based on the logic in the use case
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("should handle partial search matches", async () => {
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

    const fuelTypes = ["Diesel S10", "Diesel Comum", "Biodiesel B5", "Arla-32"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // Search for "s" should match "Diesel S10", "Diesel Comum", "Biodiesel B5"
    const sResult = await listFuelTypeUseCase.execute(user.id, 1, 10, "s");

    expect(sResult.data).toHaveLength(3);
    expect(sResult.total).toBe(3);

    // Search for "32" should match "Arla-32"
    const numberResult = await listFuelTypeUseCase.execute(
      user.id,
      1,
      10,
      "32",
    );
    expect(numberResult.data).toHaveLength(1);
    expect(numberResult.total).toBe(1);

    expect(numberResult.data[0].description).toBe("Arla-32");
  });

  it("should throw an AppError if an error occurs while listing fuel types", async () => {
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

    vi.spyOn(fuelTypeInMemory, "listFuelTypes").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(listFuelTypeUseCase.execute(user.id, 1, 10)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar listar os tipos de combustível! Por favor, tente novamente.",
        500,
      ),
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

    const fuelTypes = ["Diesel", "Gasolina", "Etanol"];

    for (const description of fuelTypes) {
      await fuelTypeInMemory.createFuelType({
        description,
        businessId: business.id as string,
      });
    }

    // Test with page size 1
    const result1 = await listFuelTypeUseCase.execute(user.id, 1, 1);

    expect(result1.data).toHaveLength(1);
    expect(result1.total).toBe(3);

    // Test with large page size
    const result100 = await listFuelTypeUseCase.execute(user.id, 1, 100);

    expect(result100.data).toHaveLength(3);
    expect(result100.total).toBe(3);
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
      description: "Diesel Test",
      businessId: business.id as string,
    });

    const result = await listFuelTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    const fuelType = result.data[0];

    expect(fuelType).toHaveProperty("id");
    expect(fuelType).toHaveProperty("description");

    expect(fuelType).toHaveProperty("businessId");
    expect(fuelType).toHaveProperty("created_at");

    expect(fuelType).toHaveProperty("updated_at");

    expect(fuelType.description).toBe("Diesel Test");
    expect(fuelType.businessId).toBe(business.id);
  });
});
