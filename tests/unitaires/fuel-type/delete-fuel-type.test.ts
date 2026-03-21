import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeleteFuelTypeUseCase } from "@/modules/fuel-type/usecases/delete-fuel-type/delete-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { FuelTypeHasAssociatedVehiclesError } from "@/modules/fuel-type/usecases/errors/fuel-type-has-associated-vehicles-error";
import { FuelTypeHasAssociatedFuelError } from "@/modules/fuel-type/usecases/errors/fuel-type-has-associated-fuel-error";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { Decimal } from "@prisma/client/runtime/library";
import { hash } from "bcrypt";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Fuel Type UseCase", () => {
  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let vehicleRepository: IVehicleRepository;

  let fuelRepository: IFuelRepository;

  let notificationService: NotificationService;
  let deleteFuelTypeUseCase: DeleteFuelTypeUseCase;

  beforeEach(() => {
    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    vehicleRepository = {
      findVehiclesByFuelTypeId: vi.fn(),
    } as any;

    fuelRepository = {
      findFuelsByFuelTypeId: vi.fn(),
    } as any;

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteFuelTypeUseCase = new DeleteFuelTypeUseCase(
      userInMemory,
      businessInMemory,
      fuelTypeInMemory,
      vehicleRepository,
      fuelRepository,
      notificationService,
    );
  });

  it("should be able to delete a fuel type", async () => {
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

    // Mock no associated vehicles and fuels
    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    const deletedFuelType = await deleteFuelTypeUseCase.execute(
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(deletedFuelType.id).toBe(createdFuelType.id);
    expect(deletedFuelType.description).toBe("Diesel S10");

    expect(deletedFuelType.businessId).toBe(business.id);
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
      deleteFuelTypeUseCase.execute(
        "fuel-type-id",
        "non-existent-user-id",
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
      deleteFuelTypeUseCase.execute(
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

    await expect(
      deleteFuelTypeUseCase.execute(
        "non-existent-fuel-type-id",
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeNotFoundError);
  });

  it("should throw FuelTypeNotBelongBusinessError if fuel type does not belong to business", async () => {
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
      description: "Gasolina Premium",
      businessId: business1.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    await expect(
      deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business2.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeNotBelongBusinessError);
  });

  it("should throw FuelTypeHasAssociatedVehiclesError if fuel type has associated vehicles", async () => {
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
      description: "Etanol",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock associated vehicles
    const mockVehicles = [
      {
        id: "vehicle-1",
        description: "Caminhão 1",
        license_plate: "ABC-1234",
        brand: "Mercedes",
        model: "Actros",
        acquisition_date: new Date(),
        fleet_type: "OWNED" as const,
        fleet_id: null,
        last_maintenance_date: null,
        current_mileage: 50000,
        last_maintenance_mileage: null,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: "12345678901",
        manufacturing_year: new Date("2020-01-01"),
        model_year: new Date("2020-01-01"),
        km_per_liter: 3.5,
        number_of_axles: 3,
        status: "ACTIVE" as const,
        businessId: business.id as string,
        vehicleTypeId: null,
        fuelTypeId: createdFuelType.id,
        driverId: null,
        branchId: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: "vehicle-2",
        description: "Caminhão 2",
        license_plate: "XYZ-5678",
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED" as const,
        fleet_id: null,
        last_maintenance_date: null,
        current_mileage: 75000,
        last_maintenance_mileage: null,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: "12345678902",
        manufacturing_year: new Date("2021-01-01"),
        model_year: new Date("2021-01-01"),
        km_per_liter: 3.2,
        number_of_axles: 4,
        status: "ACTIVE" as const,
        businessId: business.id as string,
        vehicleTypeId: null,
        fuelTypeId: createdFuelType.id,
        driverId: null,
        branchId: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];

    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue(
      mockVehicles,
    );
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    await expect(
      deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeHasAssociatedVehiclesError);
  });

  it("should throw FuelTypeHasAssociatedFuelError if fuel type has associated fuel records", async () => {
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
      description: "GNV",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock associated fuel records
    const mockFuels = [
      {
        id: "fuel-1",
        current_mileage: 10000,
        liters_amount: new Decimal(50),
        price_per_liter: new Decimal(5.5),
        total_amount: new Decimal(275),
        odometer_photo: null,
        odometer_verified: false,
        odometer_ai_status: "",
        notes: null,
        refueling_date: new Date("2024-01-01"),
        businessId: business.id as string,
        branchId: "branch-1",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        fuelTypeId: createdFuelType.id,
        created_from: "WEB_DASHBOARD" as const,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: "fuel-2",
        current_mileage: 10500,
        liters_amount: new Decimal(75),
        price_per_liter: new Decimal(5.5),
        total_amount: new Decimal(412.5),
        odometer_photo: null,
        odometer_verified: false,
        odometer_ai_status: "",
        notes: null,
        refueling_date: new Date("2024-01-02"),
        businessId: business.id as string,
        branchId: "branch-1",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        fuelTypeId: createdFuelType.id,
        created_from: "WEB_DASHBOARD" as const,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: "fuel-3",
        current_mileage: 11000,
        liters_amount: new Decimal(60),
        price_per_liter: new Decimal(5.5),
        total_amount: new Decimal(330),
        odometer_photo: null,
        odometer_verified: false,
        odometer_ai_status: "",
        notes: null,
        refueling_date: new Date("2024-01-03"),
        businessId: business.id as string,
        branchId: "branch-1",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        fuelTypeId: createdFuelType.id,
        created_from: "WEB_DASHBOARD" as const,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];

    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue(
      mockFuels,
    );

    await expect(
      deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeHasAssociatedFuelError);
  });

  it("should throw FuelTypeHasAssociatedVehiclesError with correct vehicle count", async () => {
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
      description: "Biodiesel B5",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock 5 associated vehicles
    const mockVehicles = Array.from({ length: 5 }, (_, i) => ({
      id: `vehicle-${i + 1}`,
      description: `Caminhão ${i + 1}`,
      license_plate: `ABC-${1000 + i}`,
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: new Date(),
      fleet_type: "OWNED" as const,
      fleet_id: null,
      last_maintenance_date: null,
      current_mileage: 50000 + i * 5000,
      last_maintenance_mileage: null,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `1234567890${i}`,
      manufacturing_year: new Date("2020-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3.5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      businessId: business.id as string,
      vehicleTypeId: null,
      fuelTypeId: createdFuelType.id,
      driverId: null,
      branchId: null,
      created_at: new Date(),
      updated_at: new Date(),
    }));

    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue(
      mockVehicles,
    );
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    try {
      await deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      );
    } catch (error: any) {
      expect(error).toBeInstanceOf(FuelTypeHasAssociatedVehiclesError);
      expect(error.message).toContain("5 veículo(s) associado(s)");
    }
  });

  it("should throw FuelTypeHasAssociatedFuelError with correct fuel count", async () => {
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
      description: "Arla 32",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock 3 associated fuel records
    const mockFuels = Array.from({ length: 3 }, (_, i) => ({
      id: `fuel-${i + 1}`,
      current_mileage: 10000 + i * 500,
      liters_amount: new Decimal(50 + i * 10),
      price_per_liter: new Decimal(5.5),
      total_amount: new Decimal((50 + i * 10) * 5.5),
      odometer_photo: null,
      odometer_verified: false,
      odometer_ai_status: "",
      notes: null,
      refueling_date: new Date(`2024-01-${String(i + 1).padStart(2, "0")}`),
      businessId: business.id as string,
      branchId: "branch-1",
      vehicleId: "vehicle-1",
      driverId: "driver-1",
      fuelTypeId: createdFuelType.id,
      created_from: "WEB_DASHBOARD" as const,
      created_at: new Date(),
      updated_at: new Date(),
    }));

    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue(
      mockFuels,
    );

    try {
      await deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      );
    } catch (error: any) {
      expect(error).toBeInstanceOf(FuelTypeHasAssociatedFuelError);
      expect(error.message).toContain(
        "3 registro(s) de abastecimento associado(s)",
      );
    }
  });

  it("should prioritize vehicle check over fuel check", async () => {
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
      description: "Diesel Comum",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock both associated vehicles and fuels
    const mockVehicles = [
      {
        id: "vehicle-1",
        description: "Caminhão Teste",
        license_plate: "ABC-1234",
        brand: "Mercedes",
        model: "Actros",
        acquisition_date: new Date(),
        fleet_type: "OWNED" as const,
        fleet_id: null,
        last_maintenance_date: null,
        current_mileage: 50000,
        last_maintenance_mileage: null,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: "12345678901",
        manufacturing_year: new Date("2020-01-01"),
        model_year: new Date("2020-01-01"),
        km_per_liter: 3.5,
        number_of_axles: 3,
        status: "ACTIVE" as const,
        businessId: business.id as string,
        vehicleTypeId: null,
        fuelTypeId: createdFuelType.id,
        driverId: null,
        branchId: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const mockFuels = [
      {
        id: "fuel-1",
        current_mileage: 10000,
        liters_amount: new Decimal(50),
        price_per_liter: new Decimal(5.5),
        total_amount: new Decimal(275),
        odometer_photo: null,
        odometer_verified: false,
        odometer_ai_status: "",
        notes: null,
        refueling_date: new Date("2024-01-01"),
        businessId: business.id as string,
        branchId: "branch-1",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        fuelTypeId: createdFuelType.id,
        created_from: "WEB_DASHBOARD" as const,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];

    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue(
      mockVehicles,
    );
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue(
      mockFuels,
    );

    // Should throw VehicleError first (vehicles are checked before fuels)
    await expect(
      deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(FuelTypeHasAssociatedVehiclesError);
  });

  it("should throw an AppError if an error occurs while deleting the fuel type", async () => {
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
      description: "Gasolina com Falha",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock no associated vehicles and fuels
    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    vi.spyOn(fuelTypeInMemory, "deleteFuelType").mockImplementationOnce(
      async () => {
        throw new Error("DB failure");
      },
    );

    await expect(
      deleteFuelTypeUseCase.execute(
        createdFuelType.id,
        user.id,
        business.id as string,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar o tipo de combustível! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should call notification service when deleting fuel type", async () => {
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
      description: "Diesel Para Deletar",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Mock no associated vehicles and fuels
    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    const deletedFuelType = await deleteFuelTypeUseCase.execute(
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Tipo de combustível",
      action: "delete",
      entityId: deletedFuelType.id,
      description: expect.stringContaining("Diesel Para Deletar"),
      status: "Deletado",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should successfully delete multiple different fuel types", async () => {
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
    const createdFuelTypes = [];

    // Create fuel types
    for (const description of fuelTypes) {
      const fuelTypeData = {
        description,
        businessId: business.id as string,
      };
      const created = await fuelTypeInMemory.createFuelType(fuelTypeData);
      createdFuelTypes.push(created);
    }

    // Mock no associated vehicles and fuels for all
    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    // Delete all fuel types
    for (const fuelType of createdFuelTypes) {
      const deleted = await deleteFuelTypeUseCase.execute(
        fuelType.id,
        user.id,
        business.id as string,
      );

      expect(deleted.id).toBe(fuelType.id);
      expect(deleted.description).toBe(fuelType.description);
    }
  });

  it("should handle edge case with empty vehicle and fuel arrays", async () => {
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
      description: "Biodiesel B20",
      businessId: business.id as string,
    };

    const createdFuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    // Explicitly mock empty arrays
    vi.mocked(vehicleRepository.findVehiclesByFuelTypeId).mockResolvedValue([]);
    vi.mocked(fuelRepository.findFuelsByFuelTypeId).mockResolvedValue([]);

    const deletedFuelType = await deleteFuelTypeUseCase.execute(
      createdFuelType.id,
      user.id,
      business.id as string,
    );

    expect(deletedFuelType.description).toBe("Biodiesel B20");
    expect(vehicleRepository.findVehiclesByFuelTypeId).toHaveBeenCalledWith(
      createdFuelType.id,
    );

    expect(fuelRepository.findFuelsByFuelTypeId).toHaveBeenCalledWith(
      createdFuelType.id,
    );
  });
});
