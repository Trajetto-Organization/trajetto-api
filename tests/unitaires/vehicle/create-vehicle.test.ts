import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { CreateVehicleUseCase } from "@/modules/vehicle/usecases/create-vehicle/create-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleAlreadyExistsError } from "@/modules/vehicle/usecases/errors/vehicle-already-exists-error";
import { VehicleRenavamExistsError } from "@/modules/vehicle/usecases/errors/vehicle-renavam-exists-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleModelYearError } from "@/modules/vehicle/usecases/errors/vehicle-model-year-error";
import { AppError } from "@/shared/errors/AppError";

import { NotificationService } from "@/shared/services/notification-service";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Vehicle UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let vehicleInMemory: InMemoryVehicleRepository;
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;

  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let driverInMemory: InMemoryDriverRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let createVehicle: CreateVehicleUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    vehicleInMemory = new InMemoryVehicleRepository();
    vehicleTypeInMemory = new InMemoryVehicleTypeRepository();

    fuelTypeInMemory = new InMemoryFuelTypeRepository();
    driverInMemory = new InMemoryDriverRepository();

    branchInMemory = new InMemoryBranchRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createVehicle = new CreateVehicleUseCase(
      userInMemory,
      businessInMemory,
      vehicleTypeInMemory,
      fuelTypeInMemory,
      driverInMemory,
      branchInMemory,
      vehicleInMemory,
      notificationService,
    );
  });

  it("should be able to create a vehicle", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await createVehicle.execute(vehicleData, user.id);

    expect(createdVehicle).toHaveProperty("id");
    expect(createdVehicle.description).toBe(vehicleData.description);

    expect(createdVehicle.license_plate).toBe(vehicleData.license_plate);
    expect(createdVehicle.brand).toBe(vehicleData.brand);

    expect(createdVehicle.model).toBe(vehicleData.model);
    expect(createdVehicle.renavam).toBe(vehicleData.renavam);

    expect(createdVehicle.businessId).toBe(business.id);
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledTimes(
      1,
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
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

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, "non-existing-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: "some-fuel-type-id",
      businessId: "non-existing-business-id",
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw VehicleAlreadyExistsError if vehicle with same license plate exists", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const existingVehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await vehicleInMemory.createVehicle(existingVehicleData);

    const newVehicleData = {
      description: "Outro Caminhão",
      license_plate: "ABC1234", // Same license plate
      brand: "Volvo",
      model: "FH",
      acquisition_date: "2023-02-15",
      fleet_type: "OWNED" as const,
      current_mileage: 30000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "98765432109",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(newVehicleData, user.id),
    ).rejects.toBeInstanceOf(VehicleAlreadyExistsError);
  });

  it("should throw VehicleRenavamExistsError if vehicle with same renavam exists", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const existingVehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await vehicleInMemory.createVehicle(existingVehicleData);

    const newVehicleData = {
      description: "Outro Caminhão",
      license_plate: "XYZ9876",
      brand: "Volvo",
      model: "FH",
      acquisition_date: "2023-02-15",
      fleet_type: "OWNED" as const,
      current_mileage: 30000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901", // Same RENAVAM
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(newVehicleData, user.id),
    ).rejects.toBeInstanceOf(VehicleRenavamExistsError);
  });

  it("should throw VehicleTypeNotFoundError if vehicle type does not exist", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      vehicleTypeId: "non-existing-vehicle-type-id",
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(VehicleTypeNotFoundError);
  });

  it("should throw VehicleTypeNotBelongBusinessError if vehicle type does not belong to business", async () => {
    const businessData1 = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City 1",
      uf: "TS",
      street: "Test Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "TS",
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
      password: "password",
      name: "Test User",
      businessId: business2.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const vehicleTypeData = {
      description: "Caminhão",
      number_of_axles: 3,
      businessId: business1.id as string, // Different business
    };

    const vehicleType =
      await vehicleTypeInMemory.createVehicleType(vehicleTypeData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business2.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      vehicleTypeId: vehicleType.id,
      businessId: business2.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(VehicleTypeNotBelongBusinessError);
  });

  it("should throw FuelTypeNotFoundError if fuel type does not exist", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: "non-existing-fuel-type-id",
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(FuelTypeNotFoundError);
  });

  it("should throw FuelTypeNotBelongBusinessError if fuel type does not belong to business", async () => {
    const businessData1 = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City 1",
      uf: "TS",
      street: "Test Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "TS",
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
      password: "password",
      name: "Test User",
      businessId: business2.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business1.id as string, // Different business
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business2.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(FuelTypeNotBelongBusinessError);
  });

  it("should throw VehicleModelYearError if model year is invalid", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2025-01-01", // More than one year after manufacturing
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(VehicleModelYearError);
  });

  it("should throw DriverNotFoundError if driver does not exist", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      driverId: "non-existing-driver-id",
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(DriverNotFoundError);
  });

  it("should throw DriverNotBelongBusinessError if driver does not belong to business", async () => {
    const businessData1 = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City 1",
      uf: "TS",
      street: "Test Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "TS",
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
      password: "password",
      name: "Test User",
      businessId: business2.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const driverData = {
      name: "João Silva",
      cpf: "12345678901",
      rg: "123456789",
      cnh: "12345678901",
      birth_date: "1990-01-01",
      cep: "12345678",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Exemplo",
      address_number: "123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: business1.id as string, // Different business
    };

    const driver = await driverInMemory.createDriver(driverData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business2.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      driverId: driver.id,
      businessId: business2.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(DriverNotBelongBusinessError);
  });

  it("should throw BranchNotFoundError if branch does not exist", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      branchId: "non-existing-branch-id",
      businessId: business.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it("should throw BranchNotBelongBusinessError if branch does not belong to business", async () => {
    const businessData1 = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City 1",
      uf: "TS",
      street: "Test Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "TS",
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
      password: "password",
      name: "Test User",
      businessId: business2.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia",
      cep: "11111111",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "789",
      telephone: "3333333333",
      email: "branch@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible",
      erp_code: "ERP789",
      businessId: business1.id as string, // Different business
    };

    const branch = await branchInMemory.createBranch(branchData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business2.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      branchId: branch.id,
      businessId: business2.id as string,
    };

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
  });

  it("should throw AppError if create operation fails", async () => {
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
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business.id as string,
    };

    const fuelType = await fuelTypeInMemory.createFuelType(fuelTypeData);

    const vehicleData = {
      description: "Caminhão Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: "2023-01-15",
      fleet_type: "OWNED" as const,
      current_mileage: 50000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2023-01-01",
      model_year: "2023-01-01",
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    vi.spyOn(vehicleInMemory, "createVehicle").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createVehicle.execute(vehicleData, user.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
