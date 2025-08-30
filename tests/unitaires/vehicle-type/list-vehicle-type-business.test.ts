import { describe, it, expect, beforeEach, vi } from "vitest";
import { ListVehicleTypeBusinessUseCase } from "@/modules/vehicle-type/usecases/list-vehicle-type-business/list-vehicle-type-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Vehicle Type Business UseCase", () => {
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listVehicleTypeBusinessUseCase: ListVehicleTypeBusinessUseCase;

  beforeEach(() => {
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listVehicleTypeBusinessUseCase = new ListVehicleTypeBusinessUseCase(
      userInMemory,
      vehicleTypeInMemory,
      businessInMemory,
    );
  });

  it("should be able to list vehicle types for a specific business", async () => {
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

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Caminhão 3/4");
    expect(result.data[1].description).toBe("Carreta");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      listVehicleTypeBusinessUseCase.execute(
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
      listVehicleTypeBusinessUseCase.execute(
        user.id,
        1,
        10,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should return empty list when no vehicle types exist for the specific business", async () => {
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

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return only vehicle types from the specified business", async () => {
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

    const vehicleType1Data = {
      description: "Caminhão Business 1",
      number_of_axles: 3,
      businessId: business1.id as string,
    };

    const vehicleType2Data = {
      description: "Van Business 2A",
      number_of_axles: 2,
      businessId: business2.id as string,
    };

    const vehicleType3Data = {
      description: "Carreta Business 2B",
      number_of_axles: 5,
      businessId: business2.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    await vehicleTypeInMemory.createVehicleType(vehicleType3Data);

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Van Business 2A");
    expect(result.data[1].description).toBe("Carreta Business 2B");

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
    const page1Result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      2,
      business.id as string,
    );

    expect(page1Result.data).toHaveLength(2);
    expect(page1Result.total).toBe(5);

    expect(page1Result.data[0].description).toBe("Veículo Tipo 1");
    expect(page1Result.data[1].description).toBe("Veículo Tipo 2");

    // Test page 2
    const page2Result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      2,
      2,
      business.id as string,
    );

    expect(page2Result.data).toHaveLength(2);
    expect(page2Result.total).toBe(5);

    expect(page2Result.data[0].description).toBe("Veículo Tipo 3");
    expect(page2Result.data[1].description).toBe("Veículo Tipo 4");

    // Test page 3
    const page3Result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      3,
      2,
      business.id as string,
    );

    expect(page3Result.data).toHaveLength(1);
    expect(page3Result.total).toBe(5);

    expect(page3Result.data[0].description).toBe("Veículo Tipo 5");
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

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

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

    const result = await listVehicleTypeBusinessUseCase.execute(
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

    const vehicleTypeData = {
      description: "Veículo Teste",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    // Test with MASTER user
    const masterResult = await listVehicleTypeBusinessUseCase.execute(
      masterUser.id,
      1,
      10,
      business.id as string,
    );

    expect(masterResult.data).toHaveLength(1);
    expect(masterResult.data[0].description).toBe("Veículo Teste");

    // Test with BUSINESS_USER
    const businessResult = await listVehicleTypeBusinessUseCase.execute(
      businessUser.id,
      1,
      10,
      business.id as string,
    );

    expect(businessResult.data).toHaveLength(1);
    expect(businessResult.data[0].description).toBe("Veículo Teste");
  });

  it("should list vehicle types with various number of axles correctly", async () => {
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

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(5);

    for (let i = 0; i < testCases.length; i++) {
      expect(result.data[i].description).toBe(testCases[i].description);
      expect(result.data[i].number_of_axles).toBe(testCases[i].axles);
    }
  });

  it("should handle multiple businesses with mixed vehicle types correctly", async () => {
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

    // Create many vehicle types for different businesses
    for (let i = 1; i <= 10; i++) {
      const businessId = i <= 3 ? business1.id : business2.id;
      const vehicleTypeData = {
        description: `Veículo Tipo ${i}`,
        number_of_axles: 2 + (i % 4),
        businessId: businessId as string,
      };
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    }

    // List vehicle types only for business1 (should have 3 vehicle types)
    const business1Result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business1.id as string,
    );

    expect(business1Result.data).toHaveLength(3);
    expect(business1Result.total).toBe(3);

    expect(business1Result.data[0].description).toBe("Veículo Tipo 1");
    expect(business1Result.data[1].description).toBe("Veículo Tipo 2");

    expect(business1Result.data[2].description).toBe("Veículo Tipo 3");

    // List vehicle types only for business2 (should have 7 vehicle types)
    const business2Result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business2.id as string,
    );

    expect(business2Result.data).toHaveLength(7);
    expect(business2Result.total).toBe(7);

    expect(business2Result.data[0].description).toBe("Veículo Tipo 4");
    expect(business2Result.data[6].description).toBe("Veículo Tipo 10");
  });

  it("should throw an AppError if an error occurs while listing vehicle types", async () => {
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

    vi.spyOn(
      vehicleTypeInMemory,
      "listVehicleTypeBusiness",
    ).mockImplementationOnce(async () => {
      throw new Error("DB failure");
    });

    await expect(
      listVehicleTypeBusinessUseCase.execute(
        user.id,
        1,
        10,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível recuperar a lista de tipos dos veículos por empresa!",
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

    // Create 100 vehicle types
    for (let i = 1; i <= 100; i++) {
      const vehicleTypeData = {
        description: `Veículo Tipo ${i.toString().padStart(3, "0")}`,
        number_of_axles: 2 + (i % 8), // Varying number of axles
        businessId: business.id as string,
      };
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    }

    // Test first page
    const firstPageResult = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      20,
      business.id as string,
    );

    expect(firstPageResult.data).toHaveLength(20);
    expect(firstPageResult.total).toBe(100);

    expect(firstPageResult.data[0].description).toBe("Veículo Tipo 001");
    expect(firstPageResult.data[19].description).toBe("Veículo Tipo 020");

    // Test middle page
    const middlePageResult = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      3,
      20,
      business.id as string,
    );

    expect(middlePageResult.data).toHaveLength(20);
    expect(middlePageResult.total).toBe(100);

    expect(middlePageResult.data[0].description).toBe("Veículo Tipo 041");
    expect(middlePageResult.data[19].description).toBe("Veículo Tipo 060");

    // Test last page
    const lastPageResult = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      5,
      20,
      business.id as string,
    );

    expect(lastPageResult.data).toHaveLength(20);
    expect(lastPageResult.total).toBe(100);

    expect(lastPageResult.data[0].description).toBe("Veículo Tipo 081");
    expect(lastPageResult.data[19].description).toBe("Veículo Tipo 100");
  });

  it("should handle business with same vehicle type descriptions but different axles", async () => {
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

    // This would normally not be allowed in the real system due to unique constraint
    // but this tests the list functionality
    const vehicleTypes = [
      { description: "Caminhão Pequeno", axles: 2 },
      { description: "Caminhão Médio", axles: 3 },
      { description: "Caminhão Grande", axles: 4 },
      { description: "Van Pequena", axles: 2 },
      { description: "Van Grande", axles: 3 },
    ];

    for (const vehicleType of vehicleTypes) {
      const vehicleTypeData = {
        description: vehicleType.description,
        number_of_axles: vehicleType.axles,
        businessId: business.id as string,
      };
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);
    }

    const result = await listVehicleTypeBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(5);

    // Verify all vehicle types are returned with correct details
    for (let i = 0; i < vehicleTypes.length; i++) {
      expect(result.data[i].description).toBe(vehicleTypes[i].description);
      expect(result.data[i].number_of_axles).toBe(vehicleTypes[i].axles);

      expect(result.data[i].businessId).toBe(business.id);
    }
  });
});
