import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/in-memory/in-memory-pending-deletion-provider";

import { DeleteBusinessUseCase } from "@/modules/business/usecases/delete-business/delete-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let businessInMemory: InMemoryBusinessRepository;

let pendingDeletionInMemory: InMemoryPendingDeletionProvider;
let notificationService: NotificationService;

let deleteBusiness: DeleteBusinessUseCase;

// Helper: seeds a valid pending deletion for the business and returns the plain
// confirmation code that must be passed to `execute`.
async function seedPendingDeletion(
  businessId: string,
  userId: string,
): Promise<string> {
  const code = "123456";

  await pendingDeletionInMemory.upsertPendingDeletion({
    entity_type: "business",
    entity_id: businessId,
    userId,
    code_hash: await hash(code, 8),
    expires: new Date(Date.now() + 10 * 60 * 1000),
  });

  return code;
}

describe("Delete Business UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    pendingDeletionInMemory = new InMemoryPendingDeletionProvider();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteBusiness = new DeleteBusinessUseCase(
      userInMemory,
      businessInMemory,
      pendingDeletionInMemory,
      notificationService,
    );
  });

  it("should be able to delete a business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

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
    });

    const code = await seedPendingDeletion(
      createdBusiness.id as string,
      createdUser.id,
    );

    const deletedBusiness = await deleteBusiness.execute(
      createdBusiness.id as string,
      createdUser.id,
      code,
    );

    expect(deletedBusiness.id).toEqual(createdBusiness.id);

    const findDeleted = await businessInMemory.findBusinessById(
      createdBusiness.id as string,
    );

    expect(findDeleted).toBeNull();
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
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
    });

    await expect(
      deleteBusiness.execute(
        createdBusiness.id as string,
        "non-existing-user-id",
        "123456",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

    await expect(
      deleteBusiness.execute(
        "non-existing-business-id",
        createdUser.id,
        "123456",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if delete operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

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
    });

    const code = await seedPendingDeletion(
      createdBusiness.id as string,
      createdUser.id,
    );

    vi.spyOn(businessInMemory, "deleteBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated delete failure");
      },
    );

    await expect(
      deleteBusiness.execute(createdBusiness.id as string, createdUser.id, code),
    ).rejects.toBeInstanceOf(AppError);
  });
});
