import { describe, it, expect, beforeEach, vi } from "vitest";

import { UpdateActivityNotificationsUseCase } from "@/modules/user/usecases/update-activity-notifications/update-activity-notifications-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { AppError } from "@/shared/errors/AppError";

describe("Update Activity Notifications UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let updateActivityNotificationsUseCase: UpdateActivityNotificationsUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    updateActivityNotificationsUseCase = new UpdateActivityNotificationsUseCase(
      userInMemory,
    );
  });

  it("should be able to enable activity notifications for user", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await updateActivityNotificationsUseCase.execute({
      userId: user.id,
      activity_notifications_enabled: true,
    });

    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.activity_notifications_enabled).toBe(true);
  });

  it("should be able to disable activity notifications for user", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await updateActivityNotificationsUseCase.execute({
      userId: user.id,
      activity_notifications_enabled: false,
    });

    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.activity_notifications_enabled).toBe(false);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      updateActivityNotificationsUseCase.execute({
        userId: "non-existent-user-id",
        activity_notifications_enabled: true,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if an error occurs during update process", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    vi.spyOn(
      userInMemory,
      "updateActivityNotifications",
    ).mockImplementationOnce(async () => {
      throw new Error("Database error");
    });

    await expect(
      updateActivityNotificationsUseCase.execute({
        userId: user.id,
        activity_notifications_enabled: true,
      }),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível atualizar suas notificações de atividade! Por favor, Tente novamente.",
        500,
      ),
    );
  });

  it("should call updateActivityNotifications with correct parameters", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const spyUpdateActivityNotifications = vi.spyOn(
      userInMemory,
      "updateActivityNotifications",
    );

    await updateActivityNotificationsUseCase.execute({
      userId: user.id,
      activity_notifications_enabled: true,
    });

    expect(spyUpdateActivityNotifications).toHaveBeenCalledWith({
      userId: user.id,
      activity_notifications_enabled: true,
    });
  });
});
