import { describe, it, expect, beforeEach, vi } from "vitest";
import { CreateVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/create-vehicle-type/create-vehicle-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeAlreadyExistsError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-already-exists-error";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Vehicle Type UseCase", () => {
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let createVehicleTypeUseCase: CreateVehicleTypeUseCase;

  beforeEach(() => {
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createVehicleTypeUseCase = new CreateVehicleTypeUseCase(
      userInMemory,
      businessInMemory,
      vehicleTypeInMemory,
      notificationService,
    );
  });

  it("should be able to create a vehicle type", async () => {
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
      description: "Caminhão 3/4",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const vehicleType = await createVehicleTypeUseCase.execute(
      vehicleTypeData,
      user.id,
    );

    expect(vehicleType).toHaveProperty("id");
    expect(vehicleType.description).toBe("Caminhão 3/4");

    expect(vehicleType.number_of_axles).toBe(2);
    expect(vehicleType.businessId).toBe(business.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const vehicleTypeData = {
      description: "Caminhão Toco",
      number_of_axles: 3,
      businessId: "business-id",
    };

    await expect(
      createVehicleTypeUseCase.execute(vehicleTypeData, "non-existent-user-id"),
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

    const vehicleTypeData = {
      description: "Carreta",
      number_of_axles: 5,
      businessId: "non-existent-business-id",
    };

    await expect(
      createVehicleTypeUseCase.execute(vehicleTypeData, user.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw VehicleTypeAlreadyExistsError if vehicle type description already exists in business", async () => {
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

    const existingVehicleTypeData = {
      description: "Van",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(existingVehicleTypeData);

    const newVehicleTypeData = {
      description: "Van",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    await expect(
      createVehicleTypeUseCase.execute(newVehicleTypeData, user.id),
    ).rejects.toBeInstanceOf(VehicleTypeAlreadyExistsError);
  });

  it("should allow same vehicle type description in different businesses", async () => {
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
      businessId: business2.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const vehicleTypeDataBusiness1 = {
      description: "Utilitário",
      number_of_axles: 2,
      businessId: business1.id as string,
    };

    await vehicleTypeInMemory.createVehicleType(vehicleTypeDataBusiness1);

    const vehicleTypeDataBusiness2 = {
      description: "Utilitário",
      number_of_axles: 3,
      businessId: business2.id as string,
    };

    const vehicleType = await createVehicleTypeUseCase.execute(
      vehicleTypeDataBusiness2,
      user.id,
    );

    expect(vehicleType.description).toBe("Utilitário");
    expect(vehicleType.businessId).toBe(business2.id);

    expect(vehicleType.number_of_axles).toBe(3);
  });

  it("should create vehicle types with different number of axles", async () => {
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

      const vehicleType = await createVehicleTypeUseCase.execute(
        vehicleTypeData,
        user.id,
      );

      expect(vehicleType.description).toBe(testCase.description);
      expect(vehicleType.number_of_axles).toBe(testCase.axles);

      expect(vehicleType.businessId).toBe(business.id);
    }
  });

  it("should throw an AppError if an error occurs while creating the vehicle type", async () => {
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
      description: "Caminhão com Falha",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    vi.spyOn(vehicleTypeInMemory, "createVehicleType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      createVehicleTypeUseCase.execute(vehicleTypeData, user.id),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar criar o tipo de veículo! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when creating vehicle type", async () => {
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
      description: "Caminhão Para Notificação",
      number_of_axles: 4,
      businessId: business.id as string,
    };

    const vehicleType = await createVehicleTypeUseCase.execute(
      vehicleTypeData,
      user.id,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de veículo",
      action: "create",
      entityId: vehicleType.id,
      description: expect.stringContaining("Caminhão Para Notificação"),
      status: "Completo",
      performedBy: user.id,
      businessId: business.id,
    });
  });
});
