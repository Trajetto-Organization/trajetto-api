import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { UpdateBusinessUseCase } from "@/modules/business/usecases/update-business/update-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";

import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";

import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";
import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";

import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";
import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";

import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";
import { AppError } from "@/shared/errors/AppError";

describe("Update Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let notificationService: NotificationService;

  let updateBusiness: UpdateBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();
    branchInMemory = new InMemoryBranchRepository();

    // Create a mock NotificationService
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updateBusiness = new UpdateBusinessUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      notificationService,
    );
  });

  it("should update a business successfully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    // Create a business
    const business = await businessInMemory.createBusiness({
      corporate_reason: "Original Business",
      cnpj: "11111111000100",
      fantasy_name: "Original Fantasia",
      cep: "00000000",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "1",
      telephone: "1234567890",
      email: "original@example.com",
      cnae: "1111111",
      responsible_name: "Original Responsible",
      erp_code: "ERP001",
    });

    // Create the corresponding matrix branch
    await branchInMemory.createBranch({
      corporate_reason: "Original Business",
      cnpj: "11111111000100",
      fantasy_name: "Original Fantasia",
      cep: "00000000",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "1",
      telephone: "1234567890",
      email: "original@example.com",
      cnae: "1111111",
      responsible_name: "Original Responsible",
      erp_code: "ERP001",
      businessId: business.id as string,
    });

    // Defines data to update the business
    const updateData = {
      corporate_reason: "Updated Business",
      cnpj: "11111111000100", // same CNPJ
      fantasy_name: "Updated Fantasia",
      cep: "99999999",
      city: "Updated City",
      uf: "UC",
      street: "Updated Street",
      address_number: "100",
      telephone: "0987654321",
      email: "updated@example.com",
      cnae: "2222222",
      responsible_name: "Updated Responsible",
      erp_code: "ERP001", // same ERP code
    };

    const updatedBusiness = await updateBusiness.execute({
      businessData: updateData,
      businessId: business.id as string,
      userId: user.id,
    });

    expect(updatedBusiness).toMatchObject({
      corporate_reason: "Updated Business",
      fantasy_name: "Updated Fantasia",
      cep: "99999999",
      city: "Updated City",
      uf: "UC",
      street: "Updated Street",
      address_number: "100",
      telephone: "0987654321",
      email: "updated@example.com",
      cnae: "2222222",
      responsible_name: "Updated Responsible",
    });

    // Verify that notification service was called
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Empresa",
      action: "update",
      entityId: business.id,
      description: `Empresa Updated Business atualizada`,
      status: "Atualizado",
      performedBy: user.id,
      businessId: business.id,
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    // Create a business to update
    const business = await businessInMemory.createBusiness({
      corporate_reason: "Original Business",
      cnpj: "11111111000100",
      fantasy_name: "Original Fantasia",
      cep: "00000000",
      city: "Original City",
      uf: "OC",
      street: "Original Street",
      address_number: "1",
      telephone: "1234567890",
      email: "original@example.com",
      cnae: "1111111",
      responsible_name: "Original Responsible",
      erp_code: "ERP001",
    });

    await expect(
      updateBusiness.execute({
        businessData: { corporate_reason: "New Business" },
        businessId: business.id as string,
        userId: "non-existent-user",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    // Create a valid user
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    await expect(
      updateBusiness.execute({
        businessData: { corporate_reason: "New Business" },
        businessId: "non-existent-business",
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw CnpjAlreadyExistsError if updated cnpj already exists on another business", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    // Create your first business with a specific CNPJ
    const business1 = await businessInMemory.createBusiness({
      corporate_reason: "Business One",
      cnpj: "22222222000100",
      fantasy_name: "Fantasia One",
      cep: "00000001",
      city: "City One",
      uf: "UF",
      street: "Street One",
      address_number: "10",
      telephone: "1111111111",
      email: "biz1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP001",
    });

    // Create a second business with another CNPJ
    const business2 = await businessInMemory.createBusiness({
      corporate_reason: "Business Two",
      cnpj: "33333333000100",
      fantasy_name: "Fantasia Two",
      cep: "00000002",
      city: "City Two",
      uf: "UF",
      street: "Street Two",
      address_number: "20",
      telephone: "2222222222",
      email: "biz2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP002",
    });

    // Try to update business2 with business1's CNPJ
    await expect(
      updateBusiness.execute({
        businessData: { cnpj: business1.cnpj },
        businessId: business2.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BusinessCnpjAlreadyExistsError);
  });

  it("should throw CorporateReasonAlreadyExistsError if updated corporate_reason already exists on another business", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business1 = await businessInMemory.createBusiness({
      corporate_reason: "Unique Business One",
      cnpj: "44444444000100",
      fantasy_name: "Fantasia One",
      cep: "00000003",
      city: "City Three",
      uf: "UF",
      street: "Street Three",
      address_number: "30",
      telephone: "3333333333",
      email: "biz3@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Three",
      erp_code: "ERP003",
    });

    const business2 = await businessInMemory.createBusiness({
      corporate_reason: "Unique Business Two",
      cnpj: "55555555000100",
      fantasy_name: "Fantasia Two",
      cep: "00000004",
      city: "City Four",
      uf: "UF",
      street: "Street Four",
      address_number: "40",
      telephone: "4444444444",
      email: "biz4@example.com",
      cnae: "2222222",
      responsible_name: "Responsible Four",
      erp_code: "ERP004",
    });

    // Try updating business2 with business1's corporate_reason
    await expect(
      updateBusiness.execute({
        businessData: { corporate_reason: business1.corporate_reason },
        businessId: business2.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BusinessCorporateReasonAlreadyExistsError);
  });

  it("should throw ErpCodeAlreadyExistsError if updated erp_code already exists on another business", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business1 = await businessInMemory.createBusiness({
      corporate_reason: "Business One",
      cnpj: "66666666000100",
      fantasy_name: "Fantasia One",
      cep: "00000005",
      city: "City Five",
      uf: "UF",
      street: "Street Five",
      address_number: "50",
      telephone: "5555555555",
      email: "biz5@example.com",
      cnae: "3333333",
      responsible_name: "Responsible Five",
      erp_code: "ERP005",
    });

    const business2 = await businessInMemory.createBusiness({
      corporate_reason: "Business Two",
      cnpj: "77777777000100",
      fantasy_name: "Fantasia Two",
      cep: "00000006",
      city: "City Six",
      uf: "UF",
      street: "Street Six",
      address_number: "60",
      telephone: "6666666666",
      email: "biz6@example.com",
      cnae: "4444444",
      responsible_name: "Responsible Six",
      erp_code: "ERP006",
    });

    // Try updating business2 with business1's erp_code
    await expect(
      updateBusiness.execute({
        businessData: { erp_code: business1.erp_code },
        businessId: business2.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BusinessErpCodeAlreadyExistsError);
  });

  it("should throw EmailAlreadyExistsError if updated email already exists on another business", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business1 = await businessInMemory.createBusiness({
      corporate_reason: "Business One",
      cnpj: "88888888000100",
      fantasy_name: "Fantasia One",
      cep: "00000007",
      city: "City Seven",
      uf: "UF",
      street: "Street Seven",
      address_number: "70",
      telephone: "7777777777",
      email: "duplicate@example.com",
      cnae: "5555555",
      responsible_name: "Responsible Seven",
      erp_code: "ERP007",
    });

    const business2 = await businessInMemory.createBusiness({
      corporate_reason: "Business Two",
      cnpj: "99999999000100",
      fantasy_name: "Fantasia Two",
      cep: "00000008",
      city: "City Eight",
      uf: "UF",
      street: "Street Eight",
      address_number: "80",
      telephone: "8888888888",
      email: "unique@example.com",
      cnae: "6666666",
      responsible_name: "Responsible Eight",
      erp_code: "ERP008",
    });

    // Try updating business2 with the duplicate email
    await expect(
      updateBusiness.execute({
        businessData: { email: business1.email },
        businessId: business2.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BusinessEmailAlreadyExistsError);
  });

  it("should throw BranchCnpjAlreadyExistsError if branch with same cnpj exists (but not matrix branch)", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
    });

    // Create matrix branch for the business
    await branchInMemory.createBranch({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
      businessId: business.id as string,
    });

    // Create another branch with a different CNPJ from another business
    await branchInMemory.createBranch({
      corporate_reason: "Other Branch",
      cnpj: "20202020000100", // Different CNPJ
      fantasy_name: "Other Fantasia",
      cep: "20202020",
      city: "Other City",
      uf: "OT",
      street: "Other Street",
      address_number: "202",
      telephone: "2020202020",
      email: "other@example.com",
      cnae: "8888888",
      responsible_name: "Other Responsible",
      erp_code: "ERP202",
      businessId: "other-business-id",
    });

    // Try updating business with existing branch CNPJ
    await expect(
      updateBusiness.execute({
        businessData: { cnpj: "20202020000100" },
        businessId: business.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BranchCnpjAlreadyExistsError);
  });

  it("should throw BranchNameAlreadyExistsError if branch with same corporate reason exists (but not matrix branch)", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
    });

    // Create matrix branch for the business
    await branchInMemory.createBranch({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
      businessId: business.id as string,
    });

    // Create another branch with different corporate reason from another business
    await branchInMemory.createBranch({
      corporate_reason: "Existing Branch Corporate Reason",
      cnpj: "20202020000100",
      fantasy_name: "Other Fantasia",
      cep: "20202020",
      city: "Other City",
      uf: "OT",
      street: "Other Street",
      address_number: "202",
      telephone: "2020202020",
      email: "other@example.com",
      cnae: "8888888",
      responsible_name: "Other Responsible",
      erp_code: "ERP202",
      businessId: "other-business-id",
    });

    // Try updating business with existing branch corporate reason
    await expect(
      updateBusiness.execute({
        businessData: { corporate_reason: "Existing Branch Corporate Reason" },
        businessId: business.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);
  });

  it("should throw BranchErpCodeAlreadyExistsError if branch with same erp code exists (but not matrix branch)", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
    });

    // Create matrix branch for the business
    await branchInMemory.createBranch({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
      businessId: business.id as string,
    });

    // Create another branch with different ERP code from another business
    await branchInMemory.createBranch({
      corporate_reason: "Other Branch",
      cnpj: "20202020000100",
      fantasy_name: "Other Fantasia",
      cep: "20202020",
      city: "Other City",
      uf: "OT",
      street: "Other Street",
      address_number: "202",
      telephone: "2020202020",
      email: "other@example.com",
      cnae: "8888888",
      responsible_name: "Other Responsible",
      erp_code: "EXISTING_ERP_CODE",
      businessId: "other-business-id",
    });

    // Try updating business with existing branch ERP code
    await expect(
      updateBusiness.execute({
        businessData: { erp_code: "EXISTING_ERP_CODE" },
        businessId: business.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });

  it("should throw BranchEmailAlreadyExistsError if branch with same email exists (but not matrix branch)", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
    });

    // Create matrix branch for the business
    await branchInMemory.createBranch({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
      businessId: business.id as string,
    });

    // Create another branch with different email from another business
    await branchInMemory.createBranch({
      corporate_reason: "Other Branch",
      cnpj: "20202020000100",
      fantasy_name: "Other Fantasia",
      cep: "20202020",
      city: "Other City",
      uf: "OT",
      street: "Other Street",
      address_number: "202",
      telephone: "2020202020",
      email: "existing-branch@example.com",
      cnae: "8888888",
      responsible_name: "Other Responsible",
      erp_code: "ERP202",
      businessId: "other-business-id",
    });

    // Try updating business with existing branch email
    await expect(
      updateBusiness.execute({
        businessData: { email: "existing-branch@example.com" },
        businessId: business.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(BranchEmailAlreadyExistsError);
  });

  it("should throw AppError if update operation fails", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business",
      profileAccessId: "dummy-profile",
      role: "MASTER",
    });

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business To Update",
      cnpj: "10101010000100",
      fantasy_name: "Fantasia Update",
      cep: "10101010",
      city: "City Update",
      uf: "UF",
      street: "Street Update",
      address_number: "101",
      telephone: "1010101010",
      email: "update@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Update",
      erp_code: "ERP101",
    });

    vi.spyOn(businessInMemory, "updateBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated update failure");
      },
    );

    await expect(
      updateBusiness.execute({
        businessData: { corporate_reason: "New Business" },
        businessId: business.id as string,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
