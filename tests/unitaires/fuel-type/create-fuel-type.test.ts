import { describe, it, expect, beforeEach, vi } from "vitest";
import { CreateFuelTypeUseCase } from "@/modules/fuel-type/usecases/create-fuel-type/create-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { FuelTypeAlreadyExistsError } from "@/modules/fuel-type/usecases/errors/fuel-type-already-exists-error";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Fuel Type UseCase", () => {
  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let createFuelTypeUseCase: CreateFuelTypeUseCase;

  beforeEach(() => {
    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createFuelTypeUseCase = new CreateFuelTypeUseCase(
      userInMemory,
      businessInMemory,
      fuelTypeInMemory,
      notificationService,
    );
  });

  it("should be able to create a fuel type", async () => {
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

    const fuelTypeData = {
      description: "Diesel S10",
      businessId: business.id as string,
    };

    const fuelType = await createFuelTypeUseCase.execute(fuelTypeData, user.id);

    expect(fuelType).toHaveProperty("id");
    expect(fuelType.description).toBe("Diesel S10");

    expect(fuelType.businessId).toBe(business.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const fuelTypeData = {
      description: "Gasolina Comum",
      businessId: "business-id",
    };

    await expect(
      createFuelTypeUseCase.execute(fuelTypeData, "non-existent-user-id"),
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

    const fuelTypeData = {
      description: "Etanol",
      businessId: "non-existent-business-id",
    };

    await expect(
      createFuelTypeUseCase.execute(fuelTypeData, user.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw FuelTypeAlreadyExistsError if fuel type description already exists in business", async () => {
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

    const existingFuelTypeData = {
      description: "GNV",
      businessId: business.id as string,
    };

    await fuelTypeInMemory.createFuelType(existingFuelTypeData);

    const newFuelTypeData = {
      description: "GNV",
      businessId: business.id as string,
    };

    await expect(
      createFuelTypeUseCase.execute(newFuelTypeData, user.id),
    ).rejects.toBeInstanceOf(FuelTypeAlreadyExistsError);
  });

  it("should allow same fuel type description in different businesses", async () => {
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

    const fuelTypeDataBusiness1 = {
      description: "Biodiesel B20",
      businessId: business1.id as string,
    };

    await fuelTypeInMemory.createFuelType(fuelTypeDataBusiness1);

    const fuelTypeDataBusiness2 = {
      description: "Biodiesel B20",
      businessId: business2.id as string,
    };

    const fuelType = await createFuelTypeUseCase.execute(
      fuelTypeDataBusiness2,
      user.id,
    );

    expect(fuelType.description).toBe("Biodiesel B20");
    expect(fuelType.businessId).toBe(business2.id);
  });

  it("should create fuel types with different descriptions", async () => {
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
      "Diesel S10",
      "Diesel Comum",
      "Gasolina Comum",
      "Gasolina Aditivada",
      "Etanol",
      "GNV",
      "Biodiesel B5",
      "Biodiesel B10",
      "Biodiesel B20",
      "Arla 32",
    ];

    for (const description of testCases) {
      const fuelTypeData = {
        description,
        businessId: business.id as string,
      };

      const fuelType = await createFuelTypeUseCase.execute(
        fuelTypeData,
        user.id,
      );

      expect(fuelType.description).toBe(description);
      expect(fuelType.businessId).toBe(business.id);
    }
  });

  it("should throw an AppError if an error occurs while creating the fuel type", async () => {
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

    const fuelTypeData = {
      description: "Diesel com Falha",
      businessId: business.id as string,
    };

    vi.spyOn(fuelTypeInMemory, "createFuelType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      createFuelTypeUseCase.execute(fuelTypeData, user.id),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar criar o tipo de combustível! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when creating fuel type", async () => {
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

    const fuelTypeData = {
      description: "Diesel Para Notificação",
      businessId: business.id as string,
    };

    const fuelType = await createFuelTypeUseCase.execute(fuelTypeData, user.id);

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de combustível",
      action: "create",
      entityId: fuelType.id,
      description: expect.stringContaining("Diesel Para Notificação"),
      status: "Completo",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should handle case sensitivity properly", async () => {
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

    const fuelTypeData1 = {
      description: "diesel",
      businessId: business.id as string,
    };

    const fuelType1 = await createFuelTypeUseCase.execute(
      fuelTypeData1,
      user.id,
    );

    const fuelTypeData2 = {
      description: "DIESEL",
      businessId: business.id as string,
    };

    const fuelType2 = await createFuelTypeUseCase.execute(
      fuelTypeData2,
      user.id,
    );

    expect(fuelType1.description).toBe("diesel");
    expect(fuelType2.description).toBe("DIESEL");
  });

  it("should create fuel types with special characters and numbers", async () => {
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

    const specialFuelTypes = [
      "Diesel S-10",
      "Gasolina 95 Octanas",
      "Biodiesel B5 (Mistura)",
      "Etanol H2.0",
      "GNV - Gás Natural Veicular",
      "Arla-32 (AdBlue)",
    ];

    for (const description of specialFuelTypes) {
      const fuelTypeData = {
        description,
        businessId: business.id as string,
      };

      const fuelType = await createFuelTypeUseCase.execute(
        fuelTypeData,
        user.id,
      );

      expect(fuelType.description).toBe(description);
      expect(fuelType.businessId).toBe(business.id);
    }
  });
});
