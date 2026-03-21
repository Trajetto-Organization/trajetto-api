import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { UpdateVehicleUseCase } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { VehicleCurrentMileageCanNotBeUpdatedError } from "@/modules/vehicle/usecases/errors/vehicle-current-mileage-can-not-be-updated";
import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";

import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { VehicleModelYearError } from "@/modules/vehicle/usecases/errors/vehicle-model-year-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { AppError } from "@/shared/errors/AppError";

import { NotificationService } from "@/shared/services/notification-service";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Update Vehicle UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let vehicleInMemory: InMemoryVehicleRepository;
  let vehicleTypeInMemory: InMemoryVehicleTypeRepository;

  let fuelTypeInMemory: InMemoryFuelTypeRepository;
  let driverInMemory: InMemoryDriverRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let updateVehicle: UpdateVehicleUseCase;

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

    updateVehicle = new UpdateVehicleUseCase(
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

  it("should be able to update a vehicle", async () => {
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
      current_mileage: 55000,
      status: "IN_ROUTE" as const,
    };

    const updatedVehicle = await updateVehicle.execute(
      updateData,
      createdVehicle.id,
      business.id as string,
      user.id,
    );

    expect(updatedVehicle).toHaveProperty("id");
    expect(updatedVehicle.description).toBe(updateData.description);

    expect(updatedVehicle.current_mileage).toBe(updateData.current_mileage);
    expect(updatedVehicle.status).toBe(updateData.status);

    expect(updatedVehicle.license_plate).toBe(vehicleData.license_plate);
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        "non-existing-user-id",
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: "fake-fuel-type-id",
      businessId: "fake-business-id",
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        "non-existing-business-id",
        user.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw VehicleNotFoundError if vehicle does not exist", async () => {
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

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        "non-existing-vehicle-id",
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it("should throw VehicleNotBelongBusinessError if vehicle does not belong to business", async () => {
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
      businessId: business1.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fuelTypeData = {
      description: "Diesel",
      businessId: business1.id as string,
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business1.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business2.id as string, // Different business
        user.id,
      ),
    ).rejects.toBeInstanceOf(VehicleNotBelongBusinessError);
  });

  it("should throw VehicleCurrentMileageCanNotBeUpdatedError if non-MASTER user tries to update current_mileage", async () => {
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
      role: "BUSINESS_ADMIN" as UserRole, // Not MASTER
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      current_mileage: 55000, // Trying to update mileage
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(VehicleCurrentMileageCanNotBeUpdatedError);
  });

  it("should allow MASTER user to update current_mileage", async () => {
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
      role: "MASTER" as UserRole, // MASTER user
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      current_mileage: 55000,
    };

    const updatedVehicle = await updateVehicle.execute(
      updateData,
      createdVehicle.id,
      business.id as string,
      user.id,
    );

    expect(updatedVehicle.current_mileage).toBe(55000);
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      vehicleTypeId: "non-existing-vehicle-type-id",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business2.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      vehicleTypeId: vehicleType.id,
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business2.id as string,
        user.id,
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      fuelTypeId: "non-existing-fuel-type-id",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
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

    const fuelTypeData1 = {
      description: "Diesel",
      businessId: business1.id as string, // Different business
    };

    const fuelType1 = await fuelTypeInMemory.createFuelType(fuelTypeData1);

    const fuelTypeData2 = {
      description: "Gasolina",
      businessId: business2.id as string,
    };

    const fuelType2 = await fuelTypeInMemory.createFuelType(fuelTypeData2);

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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType2.id,
      businessId: business2.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      fuelTypeId: fuelType1.id, // Fuel type from different business
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business2.id as string,
        user.id,
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      model_year: "2025-01-01", // More than one year after manufacturing
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      driverId: "non-existing-driver-id",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(DriverNotFoundError);
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      branchId: "non-existing-branch-id",
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business2.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      branchId: branch.id,
    };

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
  });

  it("should throw AppError if update operation fails", async () => {
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
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2023-01-01"),
      km_per_liter: 5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      fuelTypeId: fuelType.id,
      businessId: business.id as string,
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const updateData = {
      description: "Caminhão Mercedes Atualizado",
    };

    vi.spyOn(vehicleInMemory, "updateVehicle").mockImplementationOnce(
      async () => {
        throw new Error("Simulated update failure");
      },
    );

    await expect(
      updateVehicle.execute(
        updateData,
        createdVehicle.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
