import { describe, it, expect, beforeEach, vi } from "vitest";

import { UpdateVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/update-vehicle-type/update-vehicle-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleTypeAlreadyExistsError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-already-exists-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";

import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Update Vehicle Type UseCase", () => {
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let updateVehicleTypeUseCase: UpdateVehicleTypeUseCase;

  beforeEach(() => {
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updateVehicleTypeUseCase = new UpdateVehicleTypeUseCase(
      userInMemory,
      businessInMemory,
      vehicleTypeInMemory,
      notificationService,
    );
  });

  it("should be able to update a vehicle type description", async () => {
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

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      description: "Caminhão Toco",
      businessId: business.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(updatedVehicleType.description).toBe("Caminhão Toco");
    expect(updatedVehicleType.number_of_axles).toBe(2); // Should keep original value

    expect(updatedVehicleType.businessId).toBe(business.id);
  });

  it("should be able to update a vehicle type number of axles", async () => {
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
      description: "Carreta",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      number_of_axles: 5,
      businessId: business.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(updatedVehicleType.description).toBe("Carreta"); // Should keep original value
    expect(updatedVehicleType.number_of_axles).toBe(5);

    expect(updatedVehicleType.businessId).toBe(business.id);
  });

  it("should be able to update both description and number of axles", async () => {
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
      description: "Van",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      description: "Van Grande",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(updatedVehicleType.description).toBe("Van Grande");
    expect(updatedVehicleType.number_of_axles).toBe(3);

    expect(updatedVehicleType.businessId).toBe(business.id);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const updateData = {
      description: "Updated Vehicle Type",
      businessId: "business-id",
    };

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        "vehicle-type-id",
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
      description: "Updated Vehicle Type",
      businessId: "non-existent-business-id",
    };

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        "vehicle-type-id",
        user.id,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw VehicleTypeNotFoundError if vehicle type is not found", async () => {
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
      description: "Updated Vehicle Type",
      businessId: business.id as string,
    };

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        "non-existent-vehicle-type-id",
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(VehicleTypeNotFoundError);
  });

  it("should throw VehicleTypeNotBelongBusinessError if vehicle type does not belong to business", async () => {
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
      role: "BUSINESS_USER" as UserRole, // Not MASTER
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    const vehicleTypeDataBusiness2 = {
      description: "Caminhão Business 2",
      number_of_axles: 3,
      businessId: business2.id as string,
    };

    const vehicleTypeBusiness2 = await vehicleTypeInMemory.createVehicleType(
      vehicleTypeDataBusiness2,
    );

    const updateData = {
      description: "Updated Vehicle Type",
      businessId: business2.id as string,
    };

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        vehicleTypeBusiness2.id,
        user.id,
        business1.id as string, // Different business
      ),
    ).rejects.toBeInstanceOf(VehicleTypeNotBelongBusinessError);
  });

  it("should allow MASTER role to update vehicle types from other businesses", async () => {
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
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const masterUser = await userInMemory.createUser(masterUserData);

    const vehicleTypeDataBusiness2 = {
      description: "Caminhão Business 2",
      number_of_axles: 3,
      businessId: business2.id as string,
    };

    const vehicleTypeBusiness2 = await vehicleTypeInMemory.createVehicleType(
      vehicleTypeDataBusiness2,
    );

    const updateData = {
      description: "Updated by Master",
      businessId: business2.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      vehicleTypeBusiness2.id,
      masterUser.id,
      business1.id as string, // Different business, but master role
    );

    expect(updatedVehicleType.description).toBe("Updated by Master");
    expect(updatedVehicleType.businessId).toBe(business1.id);
  });

  it("should throw VehicleTypeAlreadyExistsError if updated description already exists in business", async () => {
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

    // Create first vehicle type
    const vehicleTypeData1 = {
      description: "Caminhão",
      number_of_axles: 3,
      businessId: business.id as string,
    };
    await vehicleTypeInMemory.createVehicleType(vehicleTypeData1);

    // Create second vehicle type
    const vehicleTypeData2 = {
      description: "Van",
      number_of_axles: 2,
      businessId: business.id as string,
    };
    const vehicleType2 =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData2);

    // Try to update second vehicle type to have same description as first
    const updateData = {
      description: "Caminhão", // Already exists
      businessId: business.id as string,
    };

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        vehicleType2.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(VehicleTypeAlreadyExistsError);
  });

  it("should allow updating to same description (no changes)", async () => {
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
      description: "Utilitário",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      description: "Utilitário", // Same description
      number_of_axles: 3, // Different axles
      businessId: business.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(updatedVehicleType.description).toBe("Utilitário");
    expect(updatedVehicleType.number_of_axles).toBe(3);
  });

  it("should throw an AppError if an error occurs while updating the vehicle type", async () => {
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

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      description: "Updated Vehicle Type",
      businessId: business.id as string,
    };

    vi.spyOn(vehicleTypeInMemory, "updateVehicleType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      updateVehicleTypeUseCase.execute(
        updateData,
        createdVehicleType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar o tipo de veículo! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when updating vehicle type", async () => {
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
      number_of_axles: 3,
      businessId: business.id as string,
    };

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const updateData = {
      description: "Caminhão Atualizado",
      number_of_axles: 4,
      businessId: business.id as string,
    };

    const updatedVehicleType = await updateVehicleTypeUseCase.execute(
      updateData,
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de veículo",
      action: "update",
      entityId: updatedVehicleType.id,
      description: expect.stringContaining("Caminhão Atualizado"),
      status: "Atualizado",
      performedBy: user.id,
      businessId: business.id,
    });
  });
});
