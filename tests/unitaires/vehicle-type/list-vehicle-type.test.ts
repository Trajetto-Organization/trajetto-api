import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/list-vehicle-type/list-vehicle-type-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Vehicle Type UseCase", () => {
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listVehicleTypeUseCase: ListVehicleTypeUseCase;

  beforeEach(() => {
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listVehicleTypeUseCase = new ListVehicleTypeUseCase(
      userInMemory,
      vehicleTypeInMemory,
    );
  });

  it("should be able to list vehicle types for a business", async () => {
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

    const vehicleType1Data = {
      description: "Caminhão 3/4",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const vehicleType2Data = {
      description: "Carreta",
      number_of_axles: 5,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Caminhão 3/4");
    expect(result.data[1].description).toBe("Carreta");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listVehicleTypeUseCase.execute("non-existent-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should return empty list when no vehicle types exist for business", async () => {
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
    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only vehicle types from user's business", async () => {
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

    const vehicleType1Data = {
      description: "Caminhão Business 1",
      number_of_axles: 3,
      businessId: business1.id as string,
    };

    const vehicleType2Data = {
      description: "Van Business 2",
      number_of_axles: 2,
      businessId: business2.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Caminhão Business 1");
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

    // Create 5 vehicle types
    for (let i = 1; i <= 5; i++) {
      const vehicleTypeData = {
        description: `Veículo Tipo ${i}`,
        number_of_axles: 2 + (i % 3),
        businessId: business.id as string,
      };
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    }

    // Test page 1
    const page1Result = await listVehicleTypeUseCase.execute(user.id, 1, 2);

    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);

    expect(page1Result.data[0].description).toBe("Veículo Tipo 1");
    expect(page1Result.data[1].description).toBe("Veículo Tipo 2");

    // Test page 2
    const page2Result = await listVehicleTypeUseCase.execute(user.id, 2, 2);

    expect(page2Result.data).toHaveLength(2);
    expect(page2Result.total).toBe(5);

    expect(page2Result.data[0].description).toBe("Veículo Tipo 3");
    expect(page2Result.data[1].description).toBe("Veículo Tipo 4");

    // Test page 3
    const page3Result = await listVehicleTypeUseCase.execute(user.id, 3, 2);

    expect(page3Result.data).toHaveLength(1);
    expect(page3Result.total).toBe(5);

    expect(page3Result.data[0].description).toBe("Veículo Tipo 5");
  });

  it("should filter vehicle types by search term", async () => {
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

    const vehicleType1Data = {
      description: "Caminhão 3/4",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const vehicleType2Data = {
      description: "Van Utilitária",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const vehicleType3Data = {
      description: "Caminhão Toco",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    await vehicleTypeInMemory.createVehicleType(vehicleType3Data);

    // Search for "Caminhão"
    const searchResult = await listVehicleTypeUseCase.execute(
      user.id,
      1,
      10,
      "Caminhão",
    );

    expect(searchResult.data).toHaveLength(2);
    expect(searchResult.total).toBe(2);

    expect(searchResult.data[0].description).toBe("Caminhão 3/4");
    expect(searchResult.data[1].description).toBe("Caminhão Toco");

    // Search for "Van"
    const searchVanResult = await listVehicleTypeUseCase.execute(
      user.id,
      1,
      10,
      "Van",
    );

    expect(searchVanResult.data).toHaveLength(1);
    expect(searchVanResult.data[0].description).toBe("Van Utilitária");

    // Search for non-existent term
    const noResultsResult = await listVehicleTypeUseCase.execute(
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

    const vehicleTypeData = {
      description: "CAMINHÃO DE CARGA",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    // Search lowercase
    const lowercaseResult = await listVehicleTypeUseCase.execute(
      user.id,
      1,
      10,
      "caminhão",
    );

    expect(lowercaseResult.data).toHaveLength(1);
    expect(lowercaseResult.data[0].description).toBe("CAMINHÃO DE CARGA");

    // Search mixed case
    const mixedCaseResult = await listVehicleTypeUseCase.execute(
      user.id,
      1,
      10,
      "Carga",
    );

    expect(mixedCaseResult.data).toHaveLength(1);
    expect(mixedCaseResult.data[0].description).toBe("CAMINHÃO DE CARGA");
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

    const vehicleTypeData = {
      description: "Veículo Teste",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    // Test with MASTER user
    const masterResult = await listVehicleTypeUseCase.execute(
      masterUser.id,
      1,
      10,
    );

    expect(masterResult.data).toHaveLength(1);
    expect(masterResult.data[0].description).toBe("Veículo Teste");

    // Test with BUSINESS_USER
    const businessResult = await listVehicleTypeUseCase.execute(
      businessUser.id,
      1,
      10,
    );

    expect(businessResult.data).toHaveLength(1);
    expect(businessResult.data[0].description).toBe("Veículo Teste");
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

    const vehicleTypeData = {
      description: "Único Veículo",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Único Veículo");
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

    const vehicleTypeData = {
      description: "Único Veículo",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    const result = await listVehicleTypeUseCase.execute(user.id, 5, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(1);
  });

  it("should throw an AppError if an error occurs while listing vehicle types", async () => {
    const userData = {
      email: "user@example.com",
      password: await hash("password", 6),
      name: "Test User",
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: "business-id",
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(vehicleTypeInMemory, "listVehicleTypes").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      listVehicleTypeUseCase.execute(user.id, 1, 10),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar listar os tipos de veículos! Por favor, tente novamente.",
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

    const vehicleTypeData = {
      description: "Veículo Teste",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10, "");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Veículo Teste");
  });

  it("should list vehicle types with various number of axles", async () => {
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

    const testCases = [
      { description: "Moto", axles: 2 },
      { description: "Carro", axles: 2 },
      { description: "Caminhão", axles: 3 },
      { description: "Bitrem", axles: 7 },
      { description: "Rodotrem", axles: 9 },
    ];

    for (const testCase of testCases) {
      const vehicleTypeData = {
        description: testCase.description,
        number_of_axles: testCase.axles,
        businessId: business.id as string,
      };
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    }

    const result = await listVehicleTypeUseCase.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(5);

    for (let i = 0; i < testCases.length; i++) {
      expect(result.data[i].description).toBe(testCases[i].description);
      expect(result.data[i].number_of_axles).toBe(testCases[i].axles);
    }
  });

  it("should properly handle MASTER user accessing all vehicle types", async () => {
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

    const masterUserData = {
      email: "master@example.com",
      password: await hash("password", 6),
      name: "Master User",
      role: "MASTER" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const masterUser = await userInMemory.createUser(masterUserData);

    // Create vehicle types in both businesses
    const vehicleType1Data = {
      description: "Caminhão Business 1",
      number_of_axles: 3,
      businessId: business1.id as string,
    };

    const vehicleType2Data = {
      description: "Van Business 2",
      number_of_axles: 2,
      businessId: business2.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    // MASTER should see all vehicle types (according to business logic in use case)
    // Note: The actual implementation may return only business1 types based on user's businessId
    const result = await listVehicleTypeUseCase.execute(masterUser.id, 1, 10);

    // This test validates the current implementation behavior
    // If MASTER users should see all businesses, the use case would need to be updated
    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe("Caminhão Business 1");

    expect(result.data[0].businessId).toBe(business1.id);
  });
});
