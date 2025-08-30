import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { InMemoryNotificationService } from "@/shared/services/in-memory/in-memory-notification-service";
import { UpdateDriverUseCase } from "@/modules/driver/usecases/update-driver/update-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { DriverCpfAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-cpf-already-exists-error";

import { DriverRgAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-rg-already-exists-error";
import { DriverLicenseAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-license-already-exists-error";

import { AppError } from "@/shared/errors/AppError";

describe("Update Driver UseCase", () => {
  let driverInMemory: InMemoryDriverRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let branchInMemory: InMemoryBranchRepository;

  let notificationService: InMemoryNotificationService;
  let updateDriver: UpdateDriverUseCase;

  beforeEach(() => {
    driverInMemory = new InMemoryDriverRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    branchInMemory = new InMemoryBranchRepository();

    notificationService = new InMemoryNotificationService();
    updateDriver = new UpdateDriverUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      driverInMemory,
      notificationService,
    );
  });

  it("should be able to update a driver", async () => {
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      complement: "Original Apt",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      name: "Updated Driver",
      city: "Updated City",
      complement: "Updated Apt",
      status: "INACTIVE" as const,
    };

    const updatedDriver = await updateDriver.execute(
      updateData,
      createdDriver.id,
      createdUser.id,
      createdBusiness.id as string,
    );

    expect(updatedDriver.name).toBe(updateData.name);
    expect(updatedDriver.city).toBe(updateData.city);

    expect(updatedDriver.complement).toBe(updateData.complement);
    expect(updatedDriver.status).toBe(updateData.status);

    expect(updatedDriver.cpf).toBe(createdDriver.cpf);
    expect(updatedDriver.cnh).toBe(createdDriver.cnh);
  });

  it("should be able to update driver with branch", async () => {
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

    const createdBranch = await branchInMemory.createBranch({
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BC",
      street: "Branch Street",
      address_number: "789",
      telephone: "9999999999",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "BRANCH123",
      businessId: createdBusiness.id as string,
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      branchId: createdBranch.id,
    };

    const updatedDriver = await updateDriver.execute(
      updateData,
      createdDriver.id,
      createdUser.id,
      createdBusiness.id as string,
    );

    expect(updatedDriver.branchId).toBe(createdBranch.id);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const updateData = {
      name: "Updated Driver",
    };

    await expect(
      updateDriver.execute(
        updateData,
        "driver-id",
        "non-existing-user-id",
        "business-id",
      ),
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

    const updateData = {
      name: "Updated Driver",
    };

    await expect(
      updateDriver.execute(
        updateData,
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

    const updateData = {
      name: "Updated Driver",
    };

    await expect(
      updateDriver.execute(
        updateData,
        "non-existing-driver-id",
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverNotFoundError);
  });

  it("should throw BranchNotFoundError if branch does not exist", async () => {
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      branchId: "non-existing-branch-id",
    };

    await expect(
      updateDriver.execute(
        updateData,
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it("should throw BranchNotBelongBusinessError if branch does not belong to business", async () => {
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

    const createdBranch = await branchInMemory.createBranch({
      corporate_reason: "Test Branch",
      cnpj: "11111111000100",
      fantasy_name: "Branch Fantasia",
      cep: "11111111",
      city: "Branch City",
      uf: "BC",
      street: "Branch Street",
      address_number: "456",
      telephone: "5555555555",
      email: "branch@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible",
      erp_code: "BRANCH123",
      businessId: anotherBusiness.id as string,
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      branchId: createdBranch.id,
    };

    await expect(
      updateDriver.execute(
        updateData,
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
  });

  it("should throw DriverCpfAlreadyExistsError if updating to existing CPF", async () => {
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

    await driverInMemory.createDriver({
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const secondDriver = await driverInMemory.createDriver({
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      cpf: "11111111111", // CPF that already exists
    };

    await expect(
      updateDriver.execute(
        updateData,
        secondDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverCpfAlreadyExistsError);
  });

  it("should throw DriverRgAlreadyExistsError if updating to existing RG", async () => {
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

    await driverInMemory.createDriver({
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const secondDriver = await driverInMemory.createDriver({
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      rg: "111111111", // RG that already exists
    };

    await expect(
      updateDriver.execute(
        updateData,
        secondDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverRgAlreadyExistsError);
  });

  it("should throw DriverLicenseAlreadyExistsError if updating to existing CNH", async () => {
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

    await driverInMemory.createDriver({
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const secondDriver = await driverInMemory.createDriver({
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "222222222",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      cnh: "11111111111", // CNH that already exists
    };

    await expect(
      updateDriver.execute(
        updateData,
        secondDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(DriverLicenseAlreadyExistsError);
  });

  it("should allow updating to same values", async () => {
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      cpf: "12345678901",
      cnh: "12345678901",
      rg: "123456789",
    };

    const updatedDriver = await updateDriver.execute(
      updateData,
      createdDriver.id,
      createdUser.id,
      createdBusiness.id as string,
    );

    expect(updatedDriver.cpf).toBe(updateData.cpf);
    expect(updatedDriver.cnh).toBe(updateData.cnh);

    expect(updatedDriver.rg).toBe(updateData.rg);
  });

  it("should throw AppError if update operation fails", async () => {
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
      name: "Original Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "12345678901",
      rg: "123456789",
      cep: "12345678",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "456",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: createdBusiness.id as string,
    });

    const updateData = {
      name: "Updated Driver",
    };

    vi.spyOn(driverInMemory, "updateDriver").mockImplementationOnce(
      async () => {
        throw new Error("Simulated update failure");
      },
    );

    await expect(
      updateDriver.execute(
        updateData,
        createdDriver.id,
        createdUser.id,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
