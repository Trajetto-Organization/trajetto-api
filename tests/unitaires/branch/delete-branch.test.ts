import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/in-memory/in-memory-pending-deletion-provider";

import { DeleteBranchUseCase } from "@/modules/branch/usecases/delete-branch/delete-branch-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

// Helper: seeds a valid pending deletion for the branch and returns the plain
// confirmation code that must be passed to `execute`.
async function seedPendingDeletion(
  pendingDeletion: InMemoryPendingDeletionProvider,
  branchId: string,
  userId: string,
): Promise<string> {
  const code = "123456";

  await pendingDeletion.upsertPendingDeletion({
    entity_type: "branch",
    entity_id: branchId,
    userId,
    code_hash: await hash(code, 8),
    expires: new Date(Date.now() + 10 * 60 * 1000),
  });

  return code;
}

describe("Delete Branch UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let pendingDeletionInMemory: InMemoryPendingDeletionProvider;

  let notificationService: NotificationService;
  let deleteBranch: DeleteBranchUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    branchInMemory = new InMemoryBranchRepository();
    pendingDeletionInMemory = new InMemoryPendingDeletionProvider();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteBranch = new DeleteBranchUseCase(
      userInMemory,
      businessInMemory,
      branchInMemory,
      pendingDeletionInMemory,
      notificationService,
    );
  });

  it("should be able to delete a branch", async () => {
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

    const code = await seedPendingDeletion(
      pendingDeletionInMemory,
      createdBranch.id,
      user.id,
    );

    const deletedBranch = await deleteBranch.execute(
      createdBranch.id,
      business.id as string,
      user.id,
      code,
    );

    expect(deletedBranch).toHaveProperty("id");
    expect(deletedBranch.corporate_reason).toBe(branchData.corporate_reason);

    expect(deletedBranch.cnpj).toBe(branchData.cnpj);
    expect(deletedBranch.email).toBe(branchData.email);

    const branchExists = await branchInMemory.findBranchById(createdBranch.id);

    expect(branchExists).toBeNull();
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

    await expect(
      deleteBranch.execute(
        createdBranch.id,
        business.id as string,
        "non-existing-user-id",
        "123456",
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

    await expect(
      deleteBranch.execute(
        createdBranch.id,
        "non-existing-business-id",
        user.id,
        "123456",
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

    await expect(
      deleteBranch.execute(
        "non-existing-branch-id",
        business.id as string,
        user.id,
        "123456",
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

    await expect(
      deleteBranch.execute(
        createdBranch.id,
        business2.id as string, // But trying to delete from business2
        user.id,
        "123456",
      ),
    ).rejects.toBeInstanceOf(BranchNotBelongBusinessError);
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

    const code = await seedPendingDeletion(
      pendingDeletionInMemory,
      createdBranch.id,
      user.id,
    );

    vi.spyOn(branchInMemory, "deleteBranch").mockImplementationOnce(
      async () => {
        throw new Error("Simulated delete failure");
      },
    );

    await expect(
      deleteBranch.execute(
        createdBranch.id,
        business.id as string,
        user.id,
        code,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
