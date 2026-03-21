import { describe, it, expect, beforeEach, vi } from "vitest";

import { DeleteVehicleTypeUseCase } from "@/modules/vehicle-type/usecases/delete-vehicle-type/delete-vehicle-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";

import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Vehicle Type UseCase", () => {
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;

  let notificationService: NotificationService;
  let deleteVehicleTypeUseCase: DeleteVehicleTypeUseCase;

  beforeEach(() => {
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteVehicleTypeUseCase = new DeleteVehicleTypeUseCase(
      userInMemory,
      businessInMemory,
      vehicleTypeInMemory,
      notificationService,
    );
  });

  it("should be able to delete a vehicle type", async () => {
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
      description: "Caminhão para Deletar",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const deletedVehicleType = await deleteVehicleTypeUseCase.execute(
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(deletedVehicleType).toHaveProperty("id");
    expect(deletedVehicleType.description).toBe("Caminhão para Deletar");

    expect(deletedVehicleType.number_of_axles).toBe(3);
    expect(deletedVehicleType.businessId).toBe(business.id);

    // Verify that vehicle type was actually deleted
    const vehicleTypeAfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType.id);
    expect(vehicleTypeAfterDeletion).toBeNull();
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      deleteVehicleTypeUseCase.execute(
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

    await expect(
      deleteVehicleTypeUseCase.execute(
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

    await expect(
      deleteVehicleTypeUseCase.execute(
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
      role: "BUSINESS_ADMIN" as UserRole,
      businessId: business1.id as string,
      profileAccessId: "profile-1",
    };

    const user = await userInMemory.createUser(userData);

    // Create vehicle type in business2
    const vehicleTypeDataBusiness2 = {
      description: "Caminhão Business 2",
      number_of_axles: 3,
      businessId: business2.id as string,
    };

    const vehicleTypeBusiness2 = await vehicleTypeInMemory.createVehicleType(
      vehicleTypeDataBusiness2,
    );

    // Try to delete from business1 (should fail)
    await expect(
      deleteVehicleTypeUseCase.execute(
        vehicleTypeBusiness2.id,
        user.id,
        business1.id as string,
      ),
    ).rejects.toBeInstanceOf(VehicleTypeNotBelongBusinessError);
  });

  it("should successfully delete vehicle type with multiple vehicle types", async () => {
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

    // Create multiple vehicle types
    const vehicleType1Data = {
      description: "Caminhão",
      number_of_axles: 3,
      businessId: business.id as string,
    };

    const vehicleType2Data = {
      description: "Van",
      number_of_axles: 2,
      businessId: business.id as string,
    };

    const vehicleType3Data = {
      description: "Carreta",
      number_of_axles: 5,
      businessId: business.id as string,
    };

    const createdVehicleType1 =
      await vehicleTypeInMemory.createVehicleType(vehicleType1Data);
    const createdVehicleType2 =
      await vehicleTypeInMemory.createVehicleType(vehicleType2Data);

    const createdVehicleType3 =
      await vehicleTypeInMemory.createVehicleType(vehicleType3Data);

    // Delete the middle one
    const deletedVehicleType = await deleteVehicleTypeUseCase.execute(
      createdVehicleType2.id,
      user.id,
      business.id as string,
    );

    expect(deletedVehicleType.description).toBe("Van");

    // Verify others still exist
    const vehicleType1AfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType1.id);
    const vehicleType3AfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType3.id);

    expect(vehicleType1AfterDeletion).not.toBeNull();
    expect(vehicleType3AfterDeletion).not.toBeNull();

    // Verify deleted one is gone
    const vehicleType2AfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType2.id);
    expect(vehicleType2AfterDeletion).toBeNull();
  });

  it("should delete vehicle type even if description is repeated in other businesses", async () => {
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

    // Create same vehicle type description in both businesses
    const vehicleTypeData1 = {
      description: "Caminhão Comum",
      number_of_axles: 3,
      businessId: business1.id as string,
    };

    const vehicleTypeData2 = {
      description: "Caminhão Comum",
      number_of_axles: 4,
      businessId: business2.id as string,
    };

    const createdVehicleType1 =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData1);
    const createdVehicleType2 =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData2);

    // Delete from business1
    const deletedVehicleType = await deleteVehicleTypeUseCase.execute(
      createdVehicleType1.id,
      user.id,
      business1.id as string,
    );

    expect(deletedVehicleType.description).toBe("Caminhão Comum");

    // Verify business1 vehicle type is deleted
    const vehicleType1AfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType1.id);
    expect(vehicleType1AfterDeletion).toBeNull();

    // Verify business2 vehicle type still exists
    const vehicleType2AfterDeletion =
      await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType2.id);
    expect(vehicleType2AfterDeletion).not.toBeNull();
    expect(vehicleType2AfterDeletion?.description).toBe("Caminhão Comum");
  });

  it("should throw an AppError if an error occurs while deleting the vehicle type", async () => {
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

    vi.spyOn(vehicleTypeInMemory, "deleteVehicleType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      deleteVehicleTypeUseCase.execute(
        createdVehicleType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar o tipo de veículo! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when deleting vehicle type", async () => {
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

    const createdVehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const deletedVehicleType = await deleteVehicleTypeUseCase.execute(
      createdVehicleType.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de veículo",
      action: "delete",
      entityId: deletedVehicleType.id,
      description: expect.stringContaining("Caminhão Para Notificação"),
      status: "Deletado",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should delete vehicle type with various number of axles", async () => {
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

      const createdVehicleType =
        await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

      const deletedVehicleType = await deleteVehicleTypeUseCase.execute(
        createdVehicleType.id,
        user.id,
        business.id as string,
      );

      expect(deletedVehicleType.description).toBe(testCase.description);
      expect(deletedVehicleType.number_of_axles).toBe(testCase.axles);

      // Verify it was actually deleted
      const vehicleTypeAfterDeletion =
        await vehicleTypeInMemory.findVehicleTypeById(createdVehicleType.id);
      expect(vehicleTypeAfterDeletion).toBeNull();
    }
  });
});
