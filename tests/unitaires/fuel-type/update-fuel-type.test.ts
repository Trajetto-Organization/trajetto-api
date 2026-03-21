import { describe, it, expect, beforeEach, vi } from "vitest";
import { UpdateFuelTypeUseCase } from "@/modules/fuel-type/usecases/update-fuel-type/update-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { FuelTypeAlreadyExistsError } from "@/modules/fuel-type/usecases/errors/fuel-type-already-exists-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Update Fuel Type UseCase", () => {
  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let updateFuelTypeUseCase: UpdateFuelTypeUseCase;

  beforeEach(() => {
    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updateFuelTypeUseCase = new UpdateFuelTypeUseCase(
      userInMemory,
      businessInMemory,
      fuelTypeInMemory,
      notificationService,
    );
  });

  it("should be able to update a fuel type description", async () => {
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

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Diesel S500",
      businessId: business.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(updatedFuelType.id).toBe(createdFuelType.id);
    expect(updatedFuelType.description).toBe("Diesel S500");

    expect(updatedFuelType.businessId).toBe(business.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const updateData = {
      description: "Gasolina Premium",
      businessId: "business-id",
    };

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        "fuel-type-id",
        "non-existent-user-id",
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

    const updateData = {
      description: "Etanol Hidratado",
      businessId: "business-id",
    };

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        "fuel-type-id",
        user.id,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw FuelTypeNotFoundError if fuel type is not found", async () => {
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

    const updateData = {
      description: "GNV",
      businessId: business.id as string,
    };

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        "non-existent-fuel-type-id",
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeNotFoundError);
  });

  it("should throw FuelTypeNotBelongBusinessError if fuel type does not belong to business and user is not MASTER", async () => {
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

    const fuelTypeData = {
      description: "Biodiesel B5",
      businessId: business1.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Biodiesel B10",
      businessId: business1.id as string,
    };

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        createdFuelType.id,
        user.id,
        business2.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeNotBelongBusinessError);
  });

  it("should allow MASTER user to update fuel type from different business", async () => {
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

    const fuelTypeData = {
      description: "Arla 32",
      businessId: business1.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Arla-32 AdBlue",
      businessId: business1.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      masterUser.id,
      business2.id as string,
    );

    expect(updatedFuelType.description).toBe("Arla-32 AdBlue");
    expect(updatedFuelType.businessId).toBe(business2.id);
  });

  it("should throw FuelTypeAlreadyExistsError if description already exists in business", async () => {
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
      description: "Gasolina Comum",
      businessId: business.id as string,
    };

    const fuelTypeData2 = {
      description: "Gasolina Aditivada",
      businessId: business.id as string,
    };

    const fuelType1 = await fuelTypeInMemory.createFuelType(fuelTypeData1);
    await fuelTypeInMemory.createFuelType(fuelTypeData2);

    const updateData = {
      description: "Gasolina Aditivada",
      businessId: business.id as string,
    };

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        fuelType1.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeAlreadyExistsError);
  });

  it("should allow updating to same description (no change)", async () => {
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
      description: "Etanol Anidro",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Etanol Anidro",
      businessId: business.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(updatedFuelType.description).toBe("Etanol Anidro");
    expect(updatedFuelType.businessId).toBe(business.id);
  });

  it("should throw an AppError if an error occurs while updating the fuel type", async () => {
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
      description: "GNV Original",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "GNV com Falha",
      businessId: business.id as string,
    };

    vi.spyOn(fuelTypeInMemory, "updateFuelType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      updateFuelTypeUseCase.execute(
        updateData,
        createdFuelType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar o tipo de combustível! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when updating fuel type", async () => {
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
      description: "Diesel Original",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Diesel Atualizado",
      businessId: business.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de combustível",
      action: "update",
      entityId: updatedFuelType.id,
      description: expect.stringContaining("Diesel Atualizado"),
      status: "Atualizado",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should update fuel type and preserve created_at timestamp", async () => {
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
      description: "Diesel B5",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);
    const originalCreatedAt = createdFuelType.created_at;

    // Add small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updateData = {
      description: "Diesel B7",
      businessId: business.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(updatedFuelType.created_at).toEqual(originalCreatedAt);
    expect(updatedFuelType.updated_at).not.toEqual(originalCreatedAt);

    expect(updatedFuelType.description).toBe("Diesel B7");
  });

  it("should handle business transfer with MASTER user", async () => {
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

    // Create same fuel type description in both businesses
    const fuelTypeDataBusiness1 = {
      description: "Diesel Especial",
      businessId: business1.id as string,
    };

    const fuelTypeDataBusiness2 = {
      description: "Gasolina Comum",
      businessId: business2.id as string,
    };

    const fuelTypeBusiness1 = await fuelTypeInMemory.createFuelType(
      fuelTypeDataBusiness1,
    );
    const fuelTypeBusiness2 = await fuelTypeInMemory.createFuelType(
      fuelTypeDataBusiness2,
    );

    // Master should be able to transfer fuel type from business2 to business1
    // by updating the Gasolina Comum to transfer to business1
    const updateData = {
      description: "Gasolina Comum",
      businessId: business2.id as string, // Keep original business in data
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      fuelTypeBusiness2.id,
      masterUser.id,
      business1.id as string, // Transfer to business1
    );

    expect(updatedFuelType.businessId).toBe(business1.id);
    expect(updatedFuelType.description).toBe("Gasolina Comum");
  });

  it("should handle partial updates (description only)", async () => {
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
      description: "Gasolina Original",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const updateData = {
      description: "Gasolina Premium Plus",
      businessId: business.id as string,
    };

    const updatedFuelType = await updateFuelTypeUseCase.execute(
      updateData,
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(updatedFuelType.description).toBe("Gasolina Premium Plus");
    expect(updatedFuelType.businessId).toBe(business.id);
  });
});
