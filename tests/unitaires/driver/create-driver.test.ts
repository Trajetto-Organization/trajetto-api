import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { InMemoryNotificationService } from "@/shared/services/in-memory/in-memory-notification-service";
import { CreateDriverUseCase } from "@/modules/driver/usecases/create-driver/create-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { DriverCpfAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-cpf-already-exists-error";
import { DriverRgAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-rg-already-exists-error";

import { DriverLicenseAlreadyExistsError } from "@/modules/driver/usecases/errors/driver-license-already-exists-error";
import { AppError } from "@/shared/errors/AppError";

describe("Create Driver UseCase", () => {
  let driverInMemory: InMemoryDriverRepository;
  let userInMemory: InMemoryUserRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let branchInMemory: InMemoryBranchRepository;

  let createDriver: CreateDriverUseCase;
  let notificationService: InMemoryNotificationService;

  beforeEach(() => {
    driverInMemory = new InMemoryDriverRepository();
    userInMemory = new InMemoryUserRepository();

    businessInMemory = new InMemoryBusinessRepository();
    branchInMemory = new InMemoryBranchRepository();

    notificationService = new InMemoryNotificationService(userInMemory);
    createDriver = new CreateDriverUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      driverInMemory,
      notificationService,
    );
  });

  it("should be able to create a driver", async () => {
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

    const driverData = {
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
      complement: "Apt 123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    const createdDriver = await createDriver.execute(
      driverData,
      createdUser.id,
    );

    expect(createdDriver).toHaveProperty("id");
    expect(createdDriver.name).toBe(driverData.name);

    expect(createdDriver.cpf).toBe(driverData.cpf);
    expect(createdDriver.cnh).toBe(driverData.cnh);

    expect(createdDriver.rg).toBe(driverData.rg);
    expect(createdDriver.businessId).toBe(driverData.businessId);

    expect(createdDriver.status).toBe(driverData.status);
    expect(createdDriver.contract_type).toBe(driverData.contract_type);
  });

  it("should be able to create a driver with branch", async () => {
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

    const driverData = {
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
      complement: "Apt 123",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
      branchId: createdBranch.id,
    };

    const createdDriver = await createDriver.execute(
      driverData,
      createdUser.id,
    );

    expect(createdDriver).toHaveProperty("id");
    expect(createdDriver.branchId).toBe(createdBranch.id);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: "non-existing-business-id",
    };

    await expect(
      createDriver.execute(driverData, "non-existing-user-id"),
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

    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: "non-existing-business-id",
    };

    await expect(
      createDriver.execute(driverData, createdUser.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
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

    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
      branchId: "non-existing-branch-id",
    };

    await expect(
      createDriver.execute(driverData, createdUser.id),
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

    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
      branchId: createdBranch.id,
    };

    await expect(
      createDriver.execute(driverData, createdUser.id),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
  });

  it("should throw DriverCpfAlreadyExistsError if driver with same CPF exists", async () => {
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

    const firstDriverData = {
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "12345678901",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    const secondDriverData = {
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "12345678901",
      rg: "222222222",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    await createDriver.execute(firstDriverData, createdUser.id);

    await expect(
      createDriver.execute(secondDriverData, createdUser.id),
    ).rejects.toBeInstanceOf(DriverCpfAlreadyExistsError);
  });

  it("should throw DriverRgAlreadyExistsError if driver with same RG exists", async () => {
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

    const firstDriverData = {
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "11111111111",
      cpf: "11111111111",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    const secondDriverData = {
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "22222222222",
      cpf: "22222222222",
      rg: "123456789",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    await createDriver.execute(firstDriverData, createdUser.id);

    await expect(
      createDriver.execute(secondDriverData, createdUser.id),
    ).rejects.toBeInstanceOf(DriverRgAlreadyExistsError);
  });

  it("should throw DriverLicenseAlreadyExistsError if driver with same CNH exists", async () => {
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

    const firstDriverData = {
      name: "First Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "11111111111",
      rg: "111111111",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    const secondDriverData = {
      name: "Second Driver",
      birth_date: new Date("1990-01-01"),
      cnh: "12345678901",
      cpf: "22222222222",
      rg: "222222222",
      cep: "12345678",
      city: "Driver City",
      uf: "DC",
      street: "Driver Street",
      address_number: "456",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    await createDriver.execute(firstDriverData, createdUser.id);

    await expect(
      createDriver.execute(secondDriverData, createdUser.id),
    ).rejects.toBeInstanceOf(DriverLicenseAlreadyExistsError);
  });

  it("should create driver with null complement when not provided", async () => {
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

    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    const createdDriver = await createDriver.execute(
      driverData,
      createdUser.id,
    );

    expect(createdDriver.complement).toBeNull();
    expect(createdDriver.branchId).toBeNull();
  });

  it("should throw AppError if create operation fails", async () => {
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

    const driverData = {
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
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: createdBusiness.id as string,
    };

    vi.spyOn(driverInMemory, "createDriver").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createDriver.execute(driverData, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
