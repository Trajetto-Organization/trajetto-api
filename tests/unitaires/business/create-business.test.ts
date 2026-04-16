import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { CreateBusinessUseCase } from "@/modules/business/usecases/create-business/create-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";

import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";

import { AppError } from "@/shared/errors/AppError";
import { NotificationService } from "@/shared/services/notification-service";

describe("Create Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let createBusiness: CreateBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    branchInMemory = new InMemoryBranchRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createBusiness = new CreateBusinessUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      notificationService,
    );
  });

  it("should be able to create a business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    const createdBusiness = await createBusiness.execute(
      businessData,
      createdUser.id,
    );

    expect(createdBusiness).toHaveProperty("id");
    expect(createdBusiness.corporate_reason).toBe(
      businessData.corporate_reason,
    );

    expect(createdBusiness.cnpj).toBe(businessData.cnpj);
    expect(createdBusiness.email).toBe(businessData.email);
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

    await expect(
      createBusiness.execute(businessData, "non-existing-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw CnpjAlreadyExistsError if business with same cnpj exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    await createBusiness.execute(businessData, createdUser.id);
    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(BusinessCnpjAlreadyExistsError);
  });

  it("should throw CorporateReasonAlreadyExistsError if business with same corporate reason exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Unique Business",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Unique Business",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP456",
    };

    await createBusiness.execute(businessData1, createdUser.id);
    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(BusinessCorporateReasonAlreadyExistsError);
  });

  it("should throw ErpCodeAlreadyExistsError if business with same erp code exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Business One",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Business Two",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP123",
    };

    await createBusiness.execute(businessData1, createdUser.id);
    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(BusinessErpCodeAlreadyExistsError);
  });

  it("should throw EmailAlreadyExistsError if business with same email exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Business One",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "duplicate@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Business Two",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "duplicate@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP456",
    };

    await createBusiness.execute(businessData1, createdUser.id);
    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(BusinessEmailAlreadyExistsError);
  });

  it("should throw BranchCnpjAlreadyExistsError if branch with same cnpj exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const existingBranch = {
      corporate_reason: "Existing Branch",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "branch@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
      businessId: "other-business-id",
    };

    await branchInMemory.createBranch(existingBranch);

    const businessData = {
      corporate_reason: "New Business",
      cnpj: "12345678000100", // Same CNPJ as existing branch
      fantasy_name: "New Fantasia",
      cep: "87654321",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "456",
      telephone: "2222222222",
      email: "newbusiness@example.com",
      cnae: "7654321",
      responsible_name: "New Responsible",
      erp_code: "ERP456",
    };

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(BranchCnpjAlreadyExistsError);
  });

  it("should throw BranchNameAlreadyExistsError if branch with same corporate reason exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const existingBranch = {
      corporate_reason: "Duplicate Corporate Reason",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "branch@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
      businessId: "other-business-id",
    };

    await branchInMemory.createBranch(existingBranch);

    const businessData = {
      corporate_reason: "Duplicate Corporate Reason", // Same corporate reason as existing branch
      cnpj: "12345678000100",
      fantasy_name: "New Fantasia",
      cep: "87654321",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "456",
      telephone: "2222222222",
      email: "newbusiness@example.com",
      cnae: "7654321",
      responsible_name: "New Responsible",
      erp_code: "ERP456",
    };

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);
  });

  it("should throw BranchErpCodeAlreadyExistsError if branch with same erp code exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const existingBranch = {
      corporate_reason: "Existing Branch",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "branch@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP999",
      businessId: "other-business-id",
    };

    await branchInMemory.createBranch(existingBranch);

    const businessData = {
      corporate_reason: "New Business",
      cnpj: "12345678000100",
      fantasy_name: "New Fantasia",
      cep: "87654321",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "456",
      telephone: "2222222222",
      email: "newbusiness@example.com",
      cnae: "7654321",
      responsible_name: "New Responsible",
      erp_code: "ERP999", // Same ERP code as existing branch
    };

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });

  it("should throw BranchEmailAlreadyExistsError if branch with same email exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const existingBranch = {
      corporate_reason: "Existing Branch",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "duplicate@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
      businessId: "other-business-id",
    };

    await branchInMemory.createBranch(existingBranch);

    const businessData = {
      corporate_reason: "New Business",
      cnpj: "12345678000100",
      fantasy_name: "New Fantasia",
      cep: "87654321",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "456",
      telephone: "2222222222",
      email: "duplicate@example.com", // Same email as existing branch
      cnae: "7654321",
      responsible_name: "New Responsible",
      erp_code: "ERP456",
    };

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(BranchEmailAlreadyExistsError);
  });

  it("should create business with branch when erp_code is null", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
      corporate_reason: "Test Business No ERP",
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
      erp_code: null,
    };

    const createdBusiness = await createBusiness.execute(
      businessData,
      createdUser.id,
    );

    expect(createdBusiness).toHaveProperty("id");
    expect(createdBusiness.corporate_reason).toBe(
      businessData.corporate_reason,
    );
    expect(createdBusiness.erp_code).toBeNull();

    // Verify branch was also created
    const createdBranch = branchInMemory.branches.find(
      (branch) => branch.businessId === createdBusiness.id,
    );
    expect(createdBranch).toBeDefined();
    expect(createdBranch?.cnpj).toBe(businessData.cnpj);
  });

  it("should throw AppError if create operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    vi.spyOn(businessInMemory, "createBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
