import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UpdateBranchUseCase } from "@/modules/branch/usecases/update-branch/update-branch-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

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

describe("Update Branch UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let updateBranch: UpdateBranchUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    branchInMemory = new InMemoryBranchRepository();
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updateBranch = new UpdateBranchUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      notificationService,
    );
  });

  it("should be able to update a branch", async () => {
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
      businessId: business.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Updated Branch Name",
      fantasy_name: "Updated Fantasia",
      city: "Updated City",
    };

    const updatedBranch = await updateBranch.execute(
      updateData,
      createdBranch.id,
      business.id as string,
      user.id,
    );

    expect(updatedBranch).toHaveProperty("id");
    expect(updatedBranch.corporate_reason).toBe(updateData.corporate_reason);
    expect(updatedBranch.fantasy_name).toBe(updateData.fantasy_name);
    expect(updatedBranch.city).toBe(updateData.city);
    expect(updatedBranch.cnpj).toBe(branchData.cnpj); // Unchanged
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

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Updated Branch Name",
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
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
      businessId: "fake-business-id",
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Updated Branch Name",
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        "non-existing-business-id",
        user.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
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

    const updateData = {
      corporate_reason: "Updated Branch Name",
    };

    await expect(
      updateBranch.execute(
        updateData,
        "non-existing-branch-id",
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
      businessId: business1.id as string,
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
      businessId: business1.id as string, // Branch belongs to business1
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Updated Branch Name",
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business2.id as string, // But trying to update from business2
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
  });

  it("should throw BranchNameAlreadyExistsError if updating to existing branch corporate reason", async () => {
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

    // Create first branch
    const branch1Data = {
      corporate_reason: "Existing Branch Name",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia 1",
      cep: "87654321",
      city: "Branch City 1",
      uf: "BS",
      street: "Branch Street 1",
      address_number: "456",
      telephone: "2222222222",
      email: "branch1@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(branch1Data);

    // Create second branch
    const branch2Data = {
      corporate_reason: "Another Branch Name",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 2",
      cep: "11111111",
      city: "Branch City 2",
      uf: "BS",
      street: "Branch Street 2",
      address_number: "789",
      telephone: "3333333333",
      email: "branch2@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 2",
      erp_code: "ERP789",
      businessId: business.id as string,
    };

    const branch2 = await branchInMemory.createBranch(branch2Data);

    const updateData = {
      corporate_reason: "Existing Branch Name", // Same as first branch
    };

    await expect(
      updateBranch.execute(
        updateData,
        branch2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);
  });

  it("should throw BranchCnpjAlreadyExistsError if updating to existing branch cnpj", async () => {
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

    // Create first branch
    const branch1Data = {
      corporate_reason: "Branch 1",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia 1",
      cep: "87654321",
      city: "Branch City 1",
      uf: "BS",
      street: "Branch Street 1",
      address_number: "456",
      telephone: "2222222222",
      email: "branch1@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(branch1Data);

    // Create second branch
    const branch2Data = {
      corporate_reason: "Branch 2",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 2",
      cep: "11111111",
      city: "Branch City 2",
      uf: "BS",
      street: "Branch Street 2",
      address_number: "789",
      telephone: "3333333333",
      email: "branch2@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 2",
      erp_code: "ERP789",
      businessId: business.id as string,
    };

    const branch2 = await branchInMemory.createBranch(branch2Data);

    const updateData = {
      cnpj: "98765432000100", // Same as first branch
    };

    await expect(
      updateBranch.execute(
        updateData,
        branch2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchCnpjAlreadyExistsError);
  });

  it("should throw BranchErpCodeAlreadyExistsError if updating to existing branch erp code", async () => {
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

    // Create first branch
    const branch1Data = {
      corporate_reason: "Branch 1",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia 1",
      cep: "87654321",
      city: "Branch City 1",
      uf: "BS",
      street: "Branch Street 1",
      address_number: "456",
      telephone: "2222222222",
      email: "branch1@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(branch1Data);

    // Create second branch
    const branch2Data = {
      corporate_reason: "Branch 2",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 2",
      cep: "11111111",
      city: "Branch City 2",
      uf: "BS",
      street: "Branch Street 2",
      address_number: "789",
      telephone: "3333333333",
      email: "branch2@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 2",
      erp_code: "ERP789",
      businessId: business.id as string,
    };

    const branch2 = await branchInMemory.createBranch(branch2Data);

    const updateData = {
      erp_code: "ERP456", // Same as first branch
    };

    await expect(
      updateBranch.execute(
        updateData,
        branch2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });

  it("should throw BranchEmailAlreadyExistsError if updating to existing branch email", async () => {
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

    // Create first branch
    const branch1Data = {
      corporate_reason: "Branch 1",
      cnpj: "98765432000100",
      fantasy_name: "Branch Fantasia 1",
      cep: "87654321",
      city: "Branch City 1",
      uf: "BS",
      street: "Branch Street 1",
      address_number: "456",
      telephone: "2222222222",
      email: "branch1@example.com",
      cnae: "7654321",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP456",
      businessId: business.id as string,
    };

    await branchInMemory.createBranch(branch1Data);

    // Create second branch
    const branch2Data = {
      corporate_reason: "Branch 2",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 2",
      cep: "11111111",
      city: "Branch City 2",
      uf: "BS",
      street: "Branch Street 2",
      address_number: "789",
      telephone: "3333333333",
      email: "branch2@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 2",
      erp_code: "ERP789",
      businessId: business.id as string,
    };

    const branch2 = await branchInMemory.createBranch(branch2Data);

    const updateData = {
      email: "branch1@example.com", // Same as first branch
    };

    await expect(
      updateBranch.execute(
        updateData,
        branch2.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(BranchEmailAlreadyExistsError);
  });

  it("should throw CnpjAlreadyExistsError if updating to existing business cnpj", async () => {
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
      businessId: business2.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      cnpj: "12345678000100", // Same as business1
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(CnpjAlreadyExistsError);
  });

  it("should throw CorporateReasonAlreadyExistsError if updating to existing business corporate reason", async () => {
    const businessData1 = {
      corporate_reason: "Existing Business Name",
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
      businessId: business2.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Existing Business Name", // Same as business1
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(CorporateReasonAlreadyExistsError);
  });

  it("should throw ErpCodeAlreadyExistsError if updating to existing business erp code", async () => {
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
      businessId: business2.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      erp_code: "ERP123", // Same as business1
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(ErpCodeAlreadyExistsError);
  });

  it("should throw EmailAlreadyExistsError if updating to existing business email", async () => {
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
      businessId: business2.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      email: "business1@example.com", // Same as business1
    };

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business2.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });

  it("should allow updating without conflicts when changing to same values", async () => {
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
      businessId: business.id as string,
    };

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Test Branch", // Same value
      cnpj: "98765432000100", // Same value
      email: "branch@example.com", // Same value
      erp_code: "ERP456", // Same value
    };

    const updatedBranch = await updateBranch.execute(
      updateData,
      createdBranch.id,
      business.id as string,
      user.id,
    );

    expect(updatedBranch).toHaveProperty("id");
    expect(updatedBranch.corporate_reason).toBe(updateData.corporate_reason);
    expect(updatedBranch.cnpj).toBe(updateData.cnpj);
    expect(updatedBranch.email).toBe(updateData.email);
    expect(updatedBranch.erp_code).toBe(updateData.erp_code);
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

    const createdBranch = await branchInMemory.createBranch(branchData);

    const updateData = {
      corporate_reason: "Updated Branch Name",
    };

    vi.spyOn(branchInMemory, "updateBranch").mockImplementationOnce(
      async () => {
        throw new Error("Simulated update failure");
      },
    );

    await expect(
      updateBranch.execute(
        updateData,
        createdBranch.id,
        business.id as string,
        user.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
