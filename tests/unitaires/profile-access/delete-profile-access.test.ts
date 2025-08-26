import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { DeleteProfileAccessUseCase } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";

import { ProfileAccessCannotBeDeletedByHimselfError } from "@/modules/profile-access/usecases/errors/profile-access-cannot-be-deleted-by-himself-error";
import { AppError } from "@/shared/errors/AppError";

describe("Delete Profile Access UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let notificationService: NotificationService;
  let deleteProfileAccess: DeleteProfileAccessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    // Create a mock NotificationService
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteProfileAccess = new DeleteProfileAccessUseCase(
      userInMemory,
      profileAccessInMemory,
      notificationService,
    );
  });

  it("should be able to delete a profile access", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        name: "Test Profile Access",
        businessId: "some-business-id",
      });

    const deletedProfile = await deleteProfileAccess.execute(
      createdProfileAccess.id,
      createdUser.id,
    );

    // ✅ Checks if the profile was deleted correctly
    expect(deletedProfile).toHaveProperty("id");
    expect(deletedProfile.name).toBe("Test Profile Access");

    // ✅ Checks whether the profile has actually been removed from the repository
    const foundProfile = await profileAccessInMemory.findProfileAccessById(
      createdProfileAccess.id,
    );
    expect(foundProfile).toBeNull();

    // Verify that notification service was called
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Perfil de acesso",
      action: "delete",
      entityId: createdProfileAccess.id,
      description: expect.stringContaining(
        `Perfil de acesso excluído: Test Profile Access`,
      ),
      status: "Deletado",
      performedBy: createdUser.id,
      businessId: "some-business-id",
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      deleteProfileAccess.execute("some-profile-id", "non-existent-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ProfileAccessNotFoundError if profile access does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(
      deleteProfileAccess.execute("non-existent-profile-id", createdUser.id),
    ).rejects.toBeInstanceOf(ProfileAccessNotFoundError);
  });

  it("should throw ProfileAccessCannotBeDeletedByHimselfError if the user tries to delete their own profile access", async () => {
    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        name: "Existing Profile",
        businessId: "some-business-id",
      });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    await expect(
      deleteProfileAccess.execute(
        createdUser.profileAccessId as string,
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessCannotBeDeletedByHimselfError);
  });

  it("should throw AppError if delete profile access operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        name: "Test Profile Access",
        businessId: "some-business-id",
      });

    // 🛠 Simulates an error when deleting the access profile
    vi.spyOn(
      profileAccessInMemory,
      "deleteProfileAccess",
    ).mockImplementationOnce(async () => {
      throw new Error("Simulated delete failure");
    });

    await expect(
      deleteProfileAccess.execute(createdProfileAccess.id, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
