import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryFineRepository } from "@/modules/fine/repositories/in-memory/in-memory-fine-repository";

import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";

import { InMemoryNotificationService } from "@/shared/services/in-memory/in-memory-notification-service";
import { DeleteDriverUseCase } from "@/modules/driver/usecases/delete-driver/delete-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { DriverHasAssociatedFinesError } from "@/modules/driver/usecases/errors/driver-has-associated-fines-error";
import { DriverHasAssociatedFuelError } from "@/modules/driver/usecases/errors/driver-has-associated-fuel-error";

import { AppError } from "@/shared/errors/AppError";

describe("Delete Driver UseCase", () => {
  let driverInMemory: InMemoryDriverRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let fineInMemory: InMemoryFineRepository;

  let fuelInMemory: InMemoryFuelRepository;
  let vehicleChecklistInMemory: InMemoryVehicleChecklistRepository;

  let notificationService: InMemoryNotificationService;
  let deleteDriver: DeleteDriverUseCase;

  beforeEach(() => {
    driverInMemory = new InMemoryDriverRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    fineInMemory = new InMemoryFineRepository();

    fuelInMemory = new InMemoryFuelRepository();
    vehicleChecklistInMemory = new InMemoryVehicleChecklistRepository();

    notificationService = new InMemoryNotificationService(userInMemory);
    deleteDriver = new DeleteDriverUseCase(
      userInMemory,
      businessInMemory,
      driverInMemory,
      fineInMemory,
      fuelInMemory,
      vehicleChecklistInMemory,
      notificationService,
    );
  });

  it("should be able to delete a driver", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const deletedDriver = await deleteDriver.execute(
      createdDriver.id,
      createdUser.id,
      createdBusiness.id as string,
    );

    expect(deletedDriver.id).toBe(createdDriver.id);
    expect(deletedDriver.name).toBe(createdDriver.name);

    // Verify driver was removed from repository
    const foundDriver = await driverInMemory.findDriverById(createdDriver.id);
    expect(foundDriver).toBeNull();
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      deleteDriver.execute("driver-id", "non-existing-user-id", "business-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(
      deleteDriver.execute(
        "driver-id",
        createdUser.id,
        "non-existing-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw DriverNotFoundError if driver does not exist", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(
      deleteDriver.execute(
        "non-existing-driver-id",
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverNotFoundError);
  });

  it("should throw DriverNotBelongBusinessError if driver does not belong to business", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const anotherBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Another Business",
      cnpj: "98765432000100",
      fantasy_name: "Another Fantasia",
      cep: "87654321",
      city: "Another City",
      uf: "AC",
      street: "Another Street",
      address_number: "789",
      telephone: "9999999999",
      email: "another@example.com",
      cnae: "7654321",
      responsible_name: "Another Responsible",
      erp_code: "ANOTHER123",
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: anotherBusiness.id as string, // Driver belongs to another business
    });

    await expect(
      deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string, // Trying to delete from different business
      ),
    ).rejects.toBeInstanceOf(DriverNotBelongBusinessError);
  });

  it("should throw DriverHasAssociatedFinesError if driver has associated fines", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    // Create an associated fine
    await fineInMemory.createFine({
      violation_date: new Date(),
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      trafficViolationCodeId: "some-code-id",
      amount: 100.5,
      points: 5,
      due_date: new Date(),
      observation: "Test fine",
      created_from: "WEB_DASHBOARD" as const,
    });

    await expect(
      deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverHasAssociatedFinesError);
  });

  it("should throw DriverHasAssociatedFuelError if driver has associated fuel records", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    // Create an associated fuel record
    await fuelInMemory.createFuel({
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      fuelTypeId: "some-fuel-type-id",
      current_mileage: 50000,
      liters_amount: 50,
      price_per_liter: 5.5,
      total_amount: 275.0,
      refueling_date: new Date(),
      notes: "Test fuel",
      created_from: "WEB_DASHBOARD" as const,
    });

    await expect(
      deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverHasAssociatedFuelError);
  });

  it("should throw DriverHasAssociatedFinesError with correct count", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    // Create multiple associated fines
    await fineInMemory.createFine({
      violation_date: new Date(),
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      trafficViolationCodeId: "some-code-id",
      amount: 100.5,
      points: 5,
      due_date: new Date(),
      observation: "Test fine 1",
      created_from: "WEB_DASHBOARD" as const,
    });

    await fineInMemory.createFine({
      violation_date: new Date(),
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      trafficViolationCodeId: "some-code-id",
      amount: 200.75,
      points: 7,
      due_date: new Date(),
      observation: "Test fine 2",
      created_from: "WEB_DASHBOARD" as const,
    });

    try {
      await deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DriverHasAssociatedFinesError);

      if (error instanceof DriverHasAssociatedFinesError) {
        expect(error.message).toContain("2"); // Should mention 2 fines
      }
    }
  });

  it("should throw DriverHasAssociatedFuelError with correct count", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    // Create multiple associated fuel records
    await fuelInMemory.createFuel({
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      fuelTypeId: "some-fuel-type-id",
      current_mileage: 50000,
      liters_amount: 50,
      price_per_liter: 5.5,
      total_amount: 275.0,
      refueling_date: new Date(),
      notes: "Test fuel 1",
      created_from: "WEB_DASHBOARD" as const,
    });

    await fuelInMemory.createFuel({
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      fuelTypeId: "some-fuel-type-id",
      current_mileage: 50500,
      liters_amount: 40,
      price_per_liter: 5.6,
      total_amount: 224.0,
      refueling_date: new Date(),
      notes: "Test fuel 2",
      created_from: "WEB_DASHBOARD" as const,
    });

    await fuelInMemory.createFuel({
      driverId: createdDriver.id,
      vehicleId: "some-vehicle-id",
      businessId: createdBusiness.id as string,
      branchId: "some-branch-id",
      fuelTypeId: "some-fuel-type-id",
      current_mileage: 51000,
      liters_amount: 45,
      price_per_liter: 5.7,
      total_amount: 256.5,
      refueling_date: new Date(),
      notes: "Test fuel 3",
      created_from: "WEB_DASHBOARD" as const,
    });

    try {
      await deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DriverHasAssociatedFuelError);

      if (error instanceof DriverHasAssociatedFuelError) {
        expect(error.message).toContain("3"); // Should mention 3 fuel records
      }
    }
  });

  it("should throw AppError if delete operation fails", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdDriver = await driverInMemory.createDriver({
      name: "Test Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    vi.spyOn(driverInMemory, "deleteDriver").mockImplementationOnce(
      async () => {
        throw new Error("Simulated delete failure");
      },
    );

    await expect(
      deleteDriver.execute(
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
