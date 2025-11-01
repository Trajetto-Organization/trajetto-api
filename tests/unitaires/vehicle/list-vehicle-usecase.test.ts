import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ListVehicleUseCase } from "@/modules/vehicle/usecases/list-vehicle/list-vehicle-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Vehicle UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let vehicleInMemory: InMemoryVehicleRepository;

  let listVehicle: ListVehicleUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    vehicleInMemory = new InMemoryVehicleRepository();

    listVehicle = new ListVehicleUseCase(userInMemory, vehicleInMemory);
  });

  it("should be able to list vehicles for logged user", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
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
      renavam: "12345678901",
      manufacturing_year: "2020-01-01",
      model_year: "2021-01-01",
      km_per_liter: 12.5,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId: "business-id-123",
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
      renavam: "98765432109",
      manufacturing_year: "2021-01-01",
      model_year: "2022-01-01",
      km_per_liter: 10.5,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    };

    await vehicleInMemory.createVehicle(vehicleData1);
    await vehicleInMemory.createVehicle(vehicleData2);

    const result = await listVehicle.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.data[0].description).toBe("Vehicle 1");
    expect(result.data[1].description).toBe("Vehicle 2");
  });

  it("should be able to list vehicles with pagination", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
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
        businessId: "business-id-123",
        vehicleTypeId: "vehicle-type-id",
        fuelTypeId: "fuel-type-id",
      });
    }

    // Get page 1 with 2 items
    const page1 = await listVehicle.execute(createdUser.id, 1, 2);

    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    // Get page 2 with 2 items
    const page2 = await listVehicle.execute(createdUser.id, 2, 2);

    expect(page2.data).toHaveLength(2);
    expect(page2.total).toBe(5);

    // Get page 3 with 2 items (should have 1 item)
    const page3 = await listVehicle.execute(createdUser.id, 3, 2);

    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it("should be able to search vehicles by description", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
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
      businessId: "business-id-123",
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
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    });

    const result = await listVehicle.execute(createdUser.id, 1, 10, "Truck");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].description).toBe("Truck Mercedes");
  });

  it("should be able to search vehicles by license plate", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
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
      businessId: "business-id-123",
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
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    });

    const result = await listVehicle.execute(createdUser.id, 1, 10, "XYZ");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].license_plate).toBe("XYZ5678");
  });

  it("should not be able to list vehicles if user is not found", async () => {
    await expect(() =>
      listVehicle.execute("invalid-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should only list vehicles from user's business", async () => {
    const userData1 = {
      name: "User 1",
      email: "user1@test.com",
      businessId: "business-id-1",
      telephone: "11111111111",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const userData2 = {
      name: "User 2",
      email: "user2@test.com",
      businessId: "business-id-2",
      telephone: "22222222222",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser1 = await userInMemory.createUser(userData1);
    await userInMemory.createUser(userData2);

    // Create vehicles for business 1
    await vehicleInMemory.createVehicle({
      description: "Vehicle Business 1",
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
      businessId: "business-id-1",
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    // Create vehicles for business 2
    await vehicleInMemory.createVehicle({
      description: "Vehicle Business 2",
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
      businessId: "business-id-2",
      vehicleTypeId: "vehicle-type-id-2",
      fuelTypeId: "fuel-type-id-2",
    });

    const result = await listVehicle.execute(createdUser1.id, 1, 10);

    // Should only return vehicles from business 1
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].description).toBe("Vehicle Business 1");
    expect(result.data[0].businessId).toBe("business-id-1");
  });

  it("should return empty list if no vehicles found", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
      telephone: "12345678901",
      role: "BUSINESS_ADMIN" as UserRole,
      password: "hashed_password",
      profileAccessId: "profile-id",
    };

    const createdUser = await userInMemory.createUser(userData);

    const result = await listVehicle.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should list vehicles for MASTER user", async () => {
    const userData = {
      name: "Master User",
      email: "master@test.com",
      businessId: "business-id-123",
      telephone: "12345678901",
      role: "MASTER" as UserRole,
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
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    const result = await listVehicle.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].description).toBe("Vehicle 1");
  });

  it("should list vehicles for BUSINESS_USER", async () => {
    const userData = {
      name: "Business User",
      email: "businessuser@test.com",
      businessId: "business-id-123",
      telephone: "12345678901",
      role: "BUSINESS_USER" as UserRole,
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
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    const result = await listVehicle.execute(createdUser.id, 1, 10);

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].description).toBe("Vehicle 1");
  });

  it("should handle search with no results", async () => {
    const userData = {
      name: "Test User",
      email: "user@test.com",
      businessId: "business-id-123",
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
      businessId: "business-id-123",
      vehicleTypeId: "vehicle-type-id",
      fuelTypeId: "fuel-type-id",
    });

    const result = await listVehicle.execute(
      createdUser.id,
      1,
      10,
      "NonExistent",
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
