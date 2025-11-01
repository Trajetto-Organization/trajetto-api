import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";

import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import { DeleteVehicleUseCase } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { VehicleHasAssociatedFinesError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-fines-error";
import { VehicleHasAssociatedServiceOrdersError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-service-orders-error";

import { VehicleHasAssociatedFuelError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-fuel-error";
import { VehicleHasAssociatedChecklistsError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-checklists-error";

import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Vehicle UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let vehicleInMemory: InMemoryVehicleRepository;
  let fuelTypeInMemory: InMemoryFuelTypeRepository;

  let fineInMemory: InMemoryFineRepository;
  let serviceOrderInMemory: InMemoryServiceOrderRepository;

  let fuelInMemory: InMemoryFuelRepository;
  let vehicleChecklistInMemory: InMemoryVehicleChecklistRepository;

  let notificationService: NotificationService;
  let deleteVehicle: DeleteVehicleUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    vehicleInMemory = new InMemoryVehicleRepository();
    fuelTypeInMemory = new InMemoryFuelTypeRepository();

    fineInMemory = new InMemoryFineRepository();
    serviceOrderInMemory = new InMemoryServiceOrderRepository();

    fuelInMemory = new InMemoryFuelRepository();
    vehicleChecklistInMemory = new InMemoryVehicleChecklistRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteVehicle = new DeleteVehicleUseCase(
      userInMemory,
      businessInMemory,
      vehicleInMemory,
      fineInMemory,
      serviceOrderInMemory,
      fuelInMemory,
      vehicleChecklistInMemory,
      notificationService,
    );
  });

  it("should be able to delete a vehicle", async () => {
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

    const deletedVehicle = await deleteVehicle.execute(
      createdVehicle.id,
      business.id as string,
      user.id,
    );

    expect(deletedVehicle).toHaveProperty("id");
    expect(deletedVehicle.description).toBe(vehicleData.description);

    expect(deletedVehicle.license_plate).toBe(vehicleData.license_plate);
    expect(deletedVehicle.brand).toBe(vehicleData.brand);

    const vehicleExists = await vehicleInMemory.findVehicleById(
      createdVehicle.id,
    );

    expect(vehicleExists).toBeNull();
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

    await expect(
      deleteVehicle.execute(
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

    await expect(
      deleteVehicle.execute(
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

    await expect(
      deleteVehicle.execute(
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
      businessId: business1.id as string, // Vehicle belongs to business1
    };

    const createdVehicle = await vehicleInMemory.createVehicle(vehicleData);

    await expect(
      deleteVehicle.execute(
        createdVehicle.id,
        business2.id as string, // But trying to delete from business2
        user.id,
      ),
    ).rejects.toBeInstanceOf(VehicleNotBelongBusinessError);
  });

  it("should throw VehicleHasAssociatedFinesError if vehicle has associated fines", async () => {
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

    // Create an associated fine
    const fineData = {
      violation_date: new Date("2023-02-01"),
      due_date: new Date("2023-03-01"),
      amount: 195.23,
      points: 5,
      location: "Rodovia BR-101",
      observation: "Excesso de velocidade",
      businessId: business.id as string,
      branchId: "some-branch-id",
      driverId: "some-driver-id",
      vehicleId: createdVehicle.id,
      trafficViolationCodeId: "some-traffic-violation-code-id",
    };

    await fineInMemory.createFine(fineData);

    await expect(
      deleteVehicle.execute(createdVehicle.id, business.id as string, user.id),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedFinesError);
  });

  it("should throw VehicleHasAssociatedServiceOrdersError if vehicle has associated service orders", async () => {
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

    // Create an associated service order
    const serviceOrderData = {
      date: new Date("2023-02-01"),
      maintenance_type: "INTERNAL" as const,
      total_amount: 500.0,
      current_mileage_at_service: 55000,
      maintenance_interval_km_at_service: 10000,
      last_maintenance_mileage_at_service: 50000,
      vehicleId: createdVehicle.id,
      responsibleUserId: user.id,
      branchId: "some-branch-id",
      businessId: business.id as string,
    };

    await serviceOrderInMemory.createServiceOrder(serviceOrderData);

    await expect(
      deleteVehicle.execute(createdVehicle.id, business.id as string, user.id),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedServiceOrdersError);
  });

  it("should throw VehicleHasAssociatedFuelError if vehicle has associated fuel records", async () => {
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

    // Create an associated fuel record
    const fuelData = {
      current_mileage: 51000,
      liters_amount: 100,
      price_per_liter: 5.5,
      refueling_date: new Date("2023-02-01"),
      businessId: business.id as string,
      branchId: "some-branch-id",
      vehicleId: createdVehicle.id,
      driverId: "some-driver-id",
      fuelTypeId: fuelType.id,
    };

    await fuelInMemory.createFuel(fuelData);

    await expect(
      deleteVehicle.execute(createdVehicle.id, business.id as string, user.id),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedFuelError);
  });

  it("should throw VehicleHasAssociatedChecklistsError if vehicle has associated checklists", async () => {
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

    // Create an associated checklist
    const checklistData = {
      current_mileage: 51000,
      checklist_date: new Date("2023-02-01"),
      tires_condition: "BOM",
      headlights_working: true,
      taillights_working: true,
      turn_signals_working: true,
      bumpers_condition: "BOM",
      windshield_condition: "BOM",
      mirrors_condition: "BOM",
      seatbelts_working: true,
      dashboard_working: true,
      steering_wheel_condition: "BOM",
      brakes_working: true,
      clutch_working: true,
      fuel_level_adequate: true,
      oil_level_adequate: true,
      radiator_water_adequate: true,
      brake_fluid_adequate: true,
      battery_condition: "BOM",
      driver_license_valid: true,
      vehicle_documents_valid: true,
      insurance_valid: true,
      fire_extinguisher_valid: true,
      warning_triangle_present: true,
      jack_present: true,
      spare_tire_condition: "BOM",
      notes: "Tudo ok",
      overall_condition: "BOM",
      vehicleId: createdVehicle.id,
      driverId: "some-driver-id",
      branchId: "some-branch-id",
      businessId: business.id as string,
    };

    await vehicleChecklistInMemory.createVehicleChecklist(checklistData);

    await expect(
      deleteVehicle.execute(createdVehicle.id, business.id as string, user.id),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedChecklistsError);
  });

  it("should throw AppError if delete operation fails", async () => {
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

    vi.spyOn(vehicleInMemory, "deleteVehicle").mockImplementationOnce(
      async () => {
        throw new Error("Simulated delete failure");
      },
    );

    await expect(
      deleteVehicle.execute(createdVehicle.id, business.id as string, user.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
