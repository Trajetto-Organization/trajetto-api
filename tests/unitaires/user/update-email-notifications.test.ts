import { describe, it, expect, beforeEach, vi } from "vitest";

import { UpdateEmailNotificationsUseCase } from "@/modules/user/usecases/update-email-notifications/update-email-notifications-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { AppError } from "@/shared/errors/AppError";

describe("Update Email Notifications UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let updateEmailNotificationsUseCase: UpdateEmailNotificationsUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    updateEmailNotificationsUseCase = new UpdateEmailNotificationsUseCase(
      userInMemory,
    );
  });

  it("should be able to enable email notifications for user", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await updateEmailNotificationsUseCase.execute({
      userId: user.id,
      email_notifications_enabled: true,
    });

    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.email_notifications_enabled).toBe(true);
  });

  it("should be able to disable email notifications for user", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await updateEmailNotificationsUseCase.execute({
      userId: user.id,
      email_notifications_enabled: false,
    });

    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.email_notifications_enabled).toBe(false);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      updateEmailNotificationsUseCase.execute({
        userId: "non-existent-user-id",
        email_notifications_enabled: true,
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

    vi.spyOn(userInMemory, "updateEmailNotifications").mockImplementationOnce(
      async () => {
        throw new Error("Database error");
      },
    );

    await expect(
      updateEmailNotificationsUseCase.execute({
        userId: user.id,
        email_notifications_enabled: true,
      }),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível atualizar suas notificações por e-mail! Por favor, Tente novamente.",
        500,
      ),
    );
  });

  it("should call updateEmailNotifications with correct parameters", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const spyUpdateEmailNotifications = vi.spyOn(
      userInMemory,
      "updateEmailNotifications",
    );

    await updateEmailNotificationsUseCase.execute({
      userId: user.id,
      email_notifications_enabled: true,
    });

    expect(spyUpdateEmailNotifications).toHaveBeenCalledWith({
      userId: user.id,
      email_notifications_enabled: true,
    });
  });
});
