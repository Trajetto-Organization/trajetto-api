import { describe, it, expect, beforeEach, vi } from "vitest";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { UserCannotBeDeletedByHimselfError } from "@/modules/user/usecases/errors/user-cannot-be-deleted-vy-himself-error";

import { DeleteUserUseCase } from "@/modules/user/usecases/delete-user/delete-user-usecase";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

describe("Delete User UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let serviceOrderInMemory: InMemoryServiceOrderRepository;

  let accountPayableInMemory: InMemoryAccountPayableRepository;
  let notificationService: NotificationService;

  let deleteUserUseCase: DeleteUserUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    serviceOrderInMemory = new InMemoryServiceOrderRepository();
    accountPayableInMemory = new InMemoryAccountPayableRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteUserUseCase = new DeleteUserUseCase(
      userInMemory,
      serviceOrderInMemory,
      accountPayableInMemory,
      notificationService,
    );
  });

  it("should be able to delete a user", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const targetUser = await userInMemory.createUser({
      email: "target@example.com",
      password: "hashed",
      name: "Target User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const deletedUser = await deleteUserUseCase.execute({
      userId: targetUser.id,
      id: adminUser.id,
    });

    expect(deletedUser).toEqual(targetUser);
  });

  it("should throw ResourceNotFoundError if admin user is not found", async () => {
    const targetUser = await userInMemory.createUser({
      email: "target@example.com",
      password: "hashed",
      name: "Target User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      deleteUserUseCase.execute({
        userId: targetUser.id,
        id: "non-existent-admin-id",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw UserCannotBeDeletedByHimselfError if admin tries to delete itself", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      deleteUserUseCase.execute({
        userId: adminUser.id,
        id: adminUser.id,
      }),
    ).rejects.toBeInstanceOf(UserCannotBeDeletedByHimselfError);
  });

  it("should throw ResourceNotFoundError if target user is not found", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      deleteUserUseCase.execute({
        userId: "non-existent-target-id",
        id: adminUser.id,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError (403) if admin role is not allowed to delete target user", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const targetUser = await userInMemory.createUser({
      email: "target@example.com",
      password: "hashed",
      name: "Target User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    targetUser.role = "MASTER";

    await expect(
      deleteUserUseCase.execute({
        userId: targetUser.id,
        id: adminUser.id,
      }),
    ).rejects.toEqual(
      new AppError(
        `Usuários com o nível de acesso "Usuário" não podem deletar usuários com o nível de acesso Master.`,
        500,
      ),
    );
  });

  it("should throw AppError (500) if deletion fails internally", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const targetUser = await userInMemory.createUser({
      email: "target@example.com",
      password: "hashed",
      name: "Target User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    vi.spyOn(userInMemory, "deleteUser").mockImplementationOnce(async () => {
      throw new Error("Internal deletion error");
    });

    await expect(
      deleteUserUseCase.execute({
        userId: targetUser.id,
        id: adminUser.id,
      }),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar o usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
