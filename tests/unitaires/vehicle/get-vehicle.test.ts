import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";

import { GetVehicleUseCase } from "@/modules/vehicle/usecases/get-vehicle/get-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Get Vehicle UseCase", () => {
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let vehicleInMemory: InMemoryVehicleRepository;

  let fuelInMemory: InMemoryFuelRepository;
  let getVehicle: GetVehicleUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    vehicleInMemory = new InMemoryVehicleRepository();
    fuelInMemory = new InMemoryFuelRepository();

    getVehicle = new GetVehicleUseCase(
      userInMemory,
      vehicleInMemory,
      businessInMemory,
      fuelInMemory,
    );
  });

  it("should be able to get a vehicle", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Test Vehicle",
      license_plate: "ABC1234",
      brand: "Test Brand",
      model: "Test Model",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      chassis: "1HGBH41JXMN109186",
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const result = await getVehicle.execute(
      createdUser.id,
      createdVehicle.id,
      createdBusiness.id as string,
    );

    expect(result).toBeTruthy();
    expect(result?.id).toBe(createdVehicle.id);

    expect(result?.description).toBe("Test Vehicle");
    expect(result?.license_plate).toBe("ABC1234");

    expect(result?.last_fuel_mileage).toBeNull();
    expect(result?.last_fuel_date).toBeNull();
  });

  it("should be able to get a vehicle with last fuel data", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Test Vehicle",
      license_plate: "ABC1234",
      brand: "Test Brand",
      model: "Test Model",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      chassis: "1HGBH41JXMN109186",
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const fuelData = {
      refueling_date: new Date("2024-01-15"),
      current_mileage: 12000,
      liters_amount: 50,
      price_per_liter: 5.5,
      total_amount: 275,
      businessId: createdBusiness.id as string,
      vehicleId: createdVehicle.id,
      driverId: "driver-id",
      branchId: "branch-id",
      fuelTypeId: "fuel-type-id",
      created_from: "WEB_DASHBOARD" as const,
    };

    await fuelInMemory.createFuel(fuelData);

    const result = await getVehicle.execute(
      createdUser.id,
      createdVehicle.id,
      createdBusiness.id as string,
    );

    expect(result).toBeTruthy();
    expect(result?.id).toBe(createdVehicle.id);

    expect(result?.description).toBe("Test Vehicle");
    expect(result?.last_fuel_mileage).toBe(12000);

    expect(result?.last_fuel_date).toEqual(new Date("2024-01-15"));
  });

  it("should not be able to get a vehicle if user is not found", async () => {
    await expect(() =>
      getVehicle.execute("invalid-user-id", "vehicle-id", "business-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should not be able to get a vehicle if business is not found", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id",
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    await expect(() =>
      getVehicle.execute(createdUser.id, "vehicle-id", "invalid-business-id"),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should not be able to get a vehicle if vehicle is not found", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    await expect(() =>
      getVehicle.execute(
        createdUser.id,
        "invalid-vehicle-id",
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it("should return null if vehicle does not belong to business", async () => {
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

    const createdBusiness1 =
      await businessInMemory.createBusiness(businessData1);

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

    const createdBusiness2 =
      await businessInMemory.createBusiness(businessData2);

    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: createdBusiness1.id as string,
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Test Vehicle",
      license_plate: "ABC1234",
      brand: "Test Brand",
      model: "Test Model",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      chassis: "1HGBH41JXMN109186",
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness2.id as string, // Vehicle belongs to business 2
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const result = await getVehicle.execute(
      createdUser.id,
      createdVehicle.id,
      createdBusiness1.id as string, // Trying to get with business 1
    );

    expect(result).toBeNull();
  });

  it("should not allow driver (BUSINESS_USER) to get vehicle not assigned to them", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const userData = {
      name: "Test Driver User",
      email: "driver@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_USER" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
      driverId: "driver-id-1",
    };

    const createdUser = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Test Vehicle",
      license_plate: "ABC1234",
      brand: "Test Brand",
      model: "Test Model",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      chassis: "1HGBH41JXMN109186",
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
      driverId: "driver-id-2", // Different driver
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    await expect(() =>
      getVehicle.execute(
        createdUser.id,
        createdVehicle.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(VehicleNotAssignedToDriverError);
  });

  it("should allow driver (BUSINESS_USER) to get vehicle assigned to them", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const userData = {
      name: "Test Driver User",
      email: "driver@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_USER" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
      driverId: "driver-id-1",
    };

    const createdUser = await userInMemory.createUser(userData);

    const vehicleData = {
      description: "Test Vehicle",
      license_plate: "ABC1234",
      brand: "Test Brand",
      model: "Test Model",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      chassis: "1HGBH41JXMN109186",
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
      driverId: "driver-id-1", // Same driver
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    const result = await getVehicle.execute(
      createdUser.id,
      createdVehicle.id,
      createdBusiness.id as string,
    );

    expect(result).toBeTruthy();
    expect(result?.id).toBe(createdVehicle.id);

    expect(result?.driverId).toBe("driver-id-1");
  });
});
