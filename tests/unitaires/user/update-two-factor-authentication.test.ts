import { expect, it, describe, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { UpdateTwoFactorAuthenticationUseCase } from "@/modules/user/usecases/update-two-factor-authentication/update-two-factor-authentication-usecase";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let updateTwoFactorAuthenticationUseCase: UpdateTwoFactorAuthenticationUseCase;

describe("Update Two Factor Authentication UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    updateTwoFactorAuthenticationUseCase =
      new UpdateTwoFactorAuthenticationUseCase(userInMemory);
  });

  it("should enable two-factor authentication when it is currently disabled", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await userInMemory.updateTwoFactorAuthentication({
      userId: user.id,
      isTwoFactorEnabled: true,
    });

    expect(user.two_factor_enabled).toBe(false);

    await updateTwoFactorAuthenticationUseCase.execute({
      userId: user.id,
    });

    const updatedUserAfterEnable = await userInMemory.findUserById(user.id);
    expect(updatedUserAfterEnable?.two_factor_enabled).toBe(false);
  });

  it("should disable two-factor authentication when it is currently enabled", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await userInMemory.updateTwoFactorAuthentication({
      userId: user.id,
      isTwoFactorEnabled: false,
    });

    await updateTwoFactorAuthenticationUseCase.execute({
      userId: user.id,
    });

    const updatedUserAfterEnable = await userInMemory.findUserById(user.id);
    expect(updatedUserAfterEnable?.two_factor_enabled).toBe(true);
  });

  it("should not be able to update two factor authentication with wrong id", async () => {
    expect(
      async () =>
        await updateTwoFactorAuthenticationUseCase.execute({
          userId: "non-existing-userId",
        }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if updating two factor authentication fails", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    vi.spyOn(
      userInMemory,
      "updateTwoFactorAuthentication",
    ).mockImplementationOnce(() => {
      throw new Error("Mocked update error");
    });

    await expect(
      updateTwoFactorAuthenticationUseCase.execute({
        userId: user.id,
      }),
    ).rejects.toThrowError(
      new AppError(
        "Não foi possível atualizar sua autenticação de dois fatores! Por favor, Tente novamente.",
        500,
      ),
    );
  });
});
