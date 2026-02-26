import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { CreateBranchUseCase } from "@/modules/branch/usecases/create-branch/create-branch-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";

import { CnpjAlreadyExistsError } from "@/modules/business/usecases/errors/cnpj-already-exists-error";
import { CorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/corporate-reason-already-exists-error";

import { ErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/erp-code-already-exists-error";
import { EmailAlreadyExistsError } from "@/modules/business/usecases/errors/email-already-exists-error";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Create Branch UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let createBranch: CreateBranchUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    branchInMemory = new InMemoryBranchRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    createBranch = new CreateBranchUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      notificationService,
    );
  });

  it("should be able to create a branch", async () => {
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

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: user.businessId as string,
    };

    const createdBranch = await createBranch.execute(
      branchData,
      business.id as string,
      user.id,
    );

    expect(createdBranch).toHaveProperty("id");
    expect(createdBranch.corporate_reason).toBe(branchData.corporate_reason);

    expect(createdBranch.cnpj).toBe(branchData.cnpj);
    expect(createdBranch.email).toBe(branchData.email);

    expect(createdBranch.businessId).toBe(business.id);
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

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await expect(
      createBranch.execute(
        branchData,
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

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(branchData, "non-existing-business-id", user.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw BranchNameAlreadyExistsError if branch with same corporate reason exists", async () => {
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

    const existingBranchData = {
      corporate_reason: "Duplicate Corporate Reason",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "existing@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(existingBranchData);

    const newBranchData = {
      corporate_reason: "Duplicate Corporate Reason",
      cnpj: "11111111000111",
      fantasy_name: "New Branch Fantasia",
      cep: "11111111",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "789",
      telephone: "3333333333",
      email: "newbranch@example.com",
      cnae: "1111111",
      responsible_name: "New Responsible",
      erp_code: "ERP789",
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(newBranchData, business.id as string, user.id),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);
  });

  it("should throw BranchCnpjAlreadyExistsError if branch with same cnpj exists", async () => {
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

    const existingBranchData = {
      corporate_reason: "Existing Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "existing@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(existingBranchData);

    const newBranchData = {
      corporate_reason: "New Branch",
      cnpj: "98765432000100", // Same CNPJ
      fantasy_name: "New Branch Fantasia",
      cep: "11111111",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "789",
      telephone: "3333333333",
      email: "newbranch@example.com",
      cnae: "1111111",
      responsible_name: "New Responsible",
      erp_code: "ERP789",
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(newBranchData, business.id as string, user.id),
    ).rejects.toBeInstanceOf(BranchCnpjAlreadyExistsError);
  });

  it("should throw BranchErpCodeAlreadyExistsError if branch with same erp code exists", async () => {
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

    const existingBranchData = {
      corporate_reason: "Existing Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "existing@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(existingBranchData);

    const newBranchData = {
      corporate_reason: "New Branch",
      cnpj: "11111111000111",
      fantasy_name: "New Branch Fantasia",
      cep: "11111111",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "789",
      telephone: "3333333333",
      email: "newbranch@example.com",
      cnae: "1111111",
      responsible_name: "New Responsible",
      erp_code: "ERP456", // Same ERP code
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(newBranchData, business.id as string, user.id),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });

  it("should throw BranchEmailAlreadyExistsError if branch with same email exists", async () => {
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

    const existingBranchData = {
      corporate_reason: "Existing Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "duplicate@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(existingBranchData);

    const newBranchData = {
      corporate_reason: "New Branch",
      cnpj: "11111111000111",
      fantasy_name: "New Branch Fantasia",
      cep: "11111111",
      city: "New City",
      uf: "NS",
      street: "New Street",
      address_number: "789",
      telephone: "3333333333",
      email: "duplicate@example.com", // Same email
      cnae: "1111111",
      responsible_name: "New Responsible",
      erp_code: "ERP789",
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(newBranchData, business.id as string, user.id),
    ).rejects.toBeInstanceOf(BranchEmailAlreadyExistsError);
  });

  it("should throw CnpjAlreadyExistsError if business with same cnpj exists", async () => {
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
      cnpj: "98765432000100", // Different CNPJ for business 2
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
      corporate_reason: "New Branch",
      cnpj: "12345678000100", // Same CNPJ as business1
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
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(branchData, business2.id as string, user.id),
    ).rejects.toBeInstanceOf(CnpjAlreadyExistsError);
  });

  it("should throw CorporateReasonAlreadyExistsError if business with same corporate reason exists", async () => {
    const businessData1 = {
      corporate_reason: "Duplicate Corporate Reason",
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
      corporate_reason: "Duplicate Corporate Reason", // Same corporate reason as business1
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
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(branchData, business2.id as string, user.id),
    ).rejects.toBeInstanceOf(CorporateReasonAlreadyExistsError);
  });

  it("should throw ErpCodeAlreadyExistsError if business with same erp code exists", async () => {
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
      corporate_reason: "New Branch",
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
      erp_code: "ERP123", // Same ERP code as business1
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(branchData, business2.id as string, user.id),
    ).rejects.toBeInstanceOf(ErpCodeAlreadyExistsError);
  });

  it("should throw EmailAlreadyExistsError if business with same email exists", async () => {
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
      email: "duplicate@example.com",
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
      corporate_reason: "New Branch",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia",
      cep: "11111111",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "789",
      telephone: "3333333333",
      email: "duplicate@example.com", // Same email as business1
      cnae: "1111111",
      responsible_name: "Branch Responsible",
      erp_code: "ERP789",
      businessId: user.businessId as string,
    };

    await expect(
      createBranch.execute(branchData, business2.id as string, user.id),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });

  it("should create branch when erp_code is null", async () => {
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

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: null,
      businessId: user.businessId as string,
    };

    const createdBranch = await createBranch.execute(
      branchData,
      business.id as string,
      user.id,
    );

    expect(createdBranch).toHaveProperty("id");
    expect(createdBranch.corporate_reason).toBe(branchData.corporate_reason);

    expect(createdBranch.erp_code).toBeNull();
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledTimes(
      1,
    );
  });

  it("should allow same cnpj, corporate_reason, erp_code and email as parent business", async () => {
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

    const branchData = {
      corporate_reason: "Test Business", // Same as business
      cnpj: "12345678000100", // Same as business
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "business@example.com", // Same as business
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP123", // Same as business
      businessId: user.businessId as string,
    };

    const createdBranch = await createBranch.execute(
      branchData,
      business.id as string,
      user.id,
    );

    expect(createdBranch).toHaveProperty("id");
    expect(createdBranch.corporate_reason).toBe(businessData.corporate_reason);

    expect(createdBranch.cnpj).toBe(businessData.cnpj);
    expect(createdBranch.email).toBe(businessData.email);

    expect(createdBranch.erp_code).toBe(businessData.erp_code);
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

    const branchData = {
      corporate_reason: "Test Branch",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia",
      cep: "87654321",
      city: "Branch City",
      uf: "BS",
      street: "Branch Street",
      address_number: "456",
      telephone: "2222222222",
      email: "branch@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible",
      erp_code: "ERP456",
      businessId: user.businessId as string,
    };

    vi.spyOn(branchInMemory, "createBranch").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createBranch.execute(branchData, business.id as string, user.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
