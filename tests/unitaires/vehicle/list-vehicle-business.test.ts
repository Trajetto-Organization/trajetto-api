import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { ListVehicleBusinessUseCase } from "@/modules/vehicle/usecases/list-vehicle-business/list-vehicle-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Vehicle Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let vehicleInMemory: InMemoryVehicleRepository;
  let listVehicle: ListVehicleBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    vehicleInMemory = new InMemoryVehicleRepository();
    listVehicle = new ListVehicleBusinessUseCase(
      userInMemory,
      vehicleInMemory,
      businessInMemory,
    );
  });

  it("should be able to list vehicles by business", async () => {
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

    const vehicleData1 = {
      description: "Vehicle 1",
      license_plate: "ABC1234",
      brand: "Brand A",
      model: "Model A",
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

    const vehicleData2 = {
      description: "Vehicle 2",
      license_plate: "XYZ5678",
      brand: "Brand B",
      model: "Model B",
      acquisition_date: new Date("2021-01-01"),
      fleet_type: "THIRD_PARTY" as const,
      current_mileage: 20000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 12,
      chassis: "2HGBH41JXMN109187",
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    };

    await vehicleInMemory.createVehicle(vehicleData1);
    await vehicleInMemory.createVehicle(vehicleData2);

    const result = await listVehicle.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    expect(result.data[0].description).toBe("Vehicle 1");
    expect(result.data[1].description).toBe("Vehicle 2");
  });

  it("should be able to list vehicles with pagination", async () => {
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

    // Create 5 vehicles
    for (let i = 1; i <= 5; i++) {
      await vehicleInMemory.createVehicle({
        description: `Vehicle ${i}`,
        license_plate: `ABC${i}234`,
        brand: `Brand ${i}`,
        model: `Model ${i}`,
        acquisition_date: new Date(`2020-0${i}-01`),
        fleet_type: "OWNED" as const,
        current_mileage: 10000 * i,
        maintenance_interval_km: 5000,
        maintenance_interval_months: 6,
        renavam: `1234567890${i}`,
        manufacturing_year: "2020-01-01",
        model_year: "2021-01-01",
        km_per_liter: 12.5,
        number_of_axles: 2,
        status: "ACTIVE" as const,
        businessId: createdBusiness.id as string,
        vehicleTypeId: "vehicle-type-id",
        fuelTypeId: "fuel-type-id",
      });
    }

    // Get page 1 with 2 items
    const page1 = await listVehicle.execute(
      createdUser.id,
      1,
      2,
      createdBusiness.id as string,
    );

    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    // Get page 2 with 2 items
    const page2 = await listVehicle.execute(
      createdUser.id,
      2,
      2,
      createdBusiness.id as string,
    );

    expect(page2.data).toHaveLength(2);
    expect(page2.total).toBe(5);

    // Get page 3 with 2 items (should have 1 item)
    const page3 = await listVehicle.execute(
      createdUser.id,
      3,
      2,
      createdBusiness.id as string,
    );

    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it("should be able to search vehicles by description", async () => {
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

    await vehicleInMemory.createVehicle({
      description: "Truck Mercedes",
      license_plate: "ABC1234",
      brand: "Mercedes",
      model: "Actros",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    await vehicleInMemory.createVehicle({
      description: "Car Toyota",
      license_plate: "XYZ5678",
      brand: "Toyota",
      model: "Corolla",
      acquisition_date: new Date("2021-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 20000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 12,
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    });

    const result = await listVehicle.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
      "Truck",
    );

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Truck Mercedes");
  });

  it("should be able to search vehicles by license plate", async () => {
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

    await vehicleInMemory.createVehicle({
      description: "Vehicle 1",
      license_plate: "ABC1234",
      brand: "Brand A",
      model: "Model A",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    await vehicleInMemory.createVehicle({
      description: "Vehicle 2",
      license_plate: "XYZ5678",
      brand: "Brand B",
      model: "Model B",
      acquisition_date: new Date("2021-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 20000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 12,
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    });

    const result = await listVehicle.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
      "XYZ",
    );

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].license_plate).toBe("XYZ5678");
  });

  it("should not be able to list vehicles if user is not found", async () => {
    await expect(() =>
      listVehicle.execute("invalid-user-id", 1, 10, "business-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should not be able to list vehicles if business is not found", async () => {
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
      listVehicle.execute(createdUser.id, 1, 10, "invalid-business-id"),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should filter vehicles by driverId when user is BUSINESS_USER with driverId", async () => {
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

    const driverUserData = {
      name: "Driver User",
      email: "driver@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_USER" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
      driverId: "driver-id-1",
    };

    const createdDriverUser = await userInMemory.createUser(driverUserData);

    // Vehicle assigned to driver 1
    await vehicleInMemory.createVehicle({
      description: "Driver 1 Vehicle",
      license_plate: "ABC1234",
      brand: "Brand A",
      model: "Model A",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
      driverId: "driver-id-1",
    });

    // Vehicle assigned to driver 2
    await vehicleInMemory.createVehicle({
      description: "Driver 2 Vehicle",
      license_plate: "XYZ5678",
      brand: "Brand B",
      model: "Model B",
      acquisition_date: new Date("2021-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 20000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 12,
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
      driverId: "driver-id-2",
    });

    const result = await listVehicle.execute(
      createdDriverUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    // Should only return vehicles assigned to driver-id-1
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].description).toBe("Driver 1 Vehicle");
    expect(result.data[0].driverId).toBe("driver-id-1");
  });

  it("should return all vehicles when user is BUSINESS_ADMIN (no driver filter)", async () => {
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

    const adminUserData = {
      name: "Admin User",
      email: "admin@test.com",
      businessId: createdBusiness.id as string,
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdAdminUser = await userInMemory.createUser(adminUserData);

    // Vehicle assigned to driver 1
    await vehicleInMemory.createVehicle({
      description: "Driver 1 Vehicle",
      license_plate: "ABC1234",
      brand: "Brand A",
      model: "Model A",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 10000,
      maintenance_interval_km: 5000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
      driverId: "driver-id-1",
    });

    // Vehicle assigned to driver 2
    await vehicleInMemory.createVehicle({
      description: "Driver 2 Vehicle",
      license_plate: "XYZ5678",
      brand: "Brand B",
      model: "Model B",
      acquisition_date: new Date("2021-01-01"),
      fleet_type: "OWNED" as const,
      current_mileage: 20000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 12,
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: createdBusiness.id as string,
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
      driverId: "driver-id-2",
    });

    const result = await listVehicle.execute(
      createdAdminUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    // Should return all vehicles (no driver filter for admin)
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("should return empty list if no vehicles found", async () => {
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

    const result = await listVehicle.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
