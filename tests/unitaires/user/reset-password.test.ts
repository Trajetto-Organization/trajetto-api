import { describe, it, expect, beforeEach, vi } from "vitest";
import { compare, hash } from "bcrypt";

import { v4 as uuidV4 } from "uuid";

import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";

import { InMemoryUsersTokens } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InvalidTokenError } from "@/modules/user/usecases/errors/invalid-token-error";
import { ExpiredTokenError } from "@/modules/user/usecases/errors/expired-token-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;

let usersTokensInMemory: InMemoryUsersTokens;
let resetUserPasswordUseCase: ResetUserPasswordUseCase;

let token: string;

describe("Reset User Password UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUsersTokens();

    resetUserPasswordUseCase = new ResetUserPasswordUseCase(
      userInMemory,
      usersTokensInMemory,
    );
    token = uuidV4();
  });

  it("should reset password with a valid token", async () => {
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

    const validToken =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: user.email,
        expires: new Date(Date.now() + 1000 * 60 * 15), // 15 minutes from now
      });

    await resetUserPasswordUseCase.execute({
      token: validToken.token,
      password: "new-password",
    });

    const updatedUser = await userInMemory.findUserByEmail(user.email);

    expect(await compare("password123", updatedUser?.password as string)).toBe(
      false,
    ); // Ensure new password is different from the old one

    expect(await compare("new-password", updatedUser?.password as string)).toBe(
      true,
    );
  });

  it("should throw InvalidResetPasswordToken if token does not exist", async () => {
    await expect(
      resetUserPasswordUseCase.execute({
        token: "invalid-token",
        password: "new-password",
      }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("should throw ExpiredResetPasswordToken if token has expired", async () => {
    const expiredToken =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: "user@gmail.com",
        expires: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
      });

    await expect(
      resetUserPasswordUseCase.execute({
        token: expiredToken.token,
        password: "new-password",
      }),
    ).rejects.toBeInstanceOf(ExpiredTokenError);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const validToken =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: "non-existent@example.com",
        expires: new Date(Date.now() + 1000 * 60 * 15), //15 minutes from now
      });

    await expect(
      resetUserPasswordUseCase.execute({
        token: validToken.token,
        password: "new-password",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if updateUserPassword fails", async () => {
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

    const validToken =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: user.email,
        expires: new Date(Date.now() + 1000 * 60 * 15), // 15 minutes from now
      });

    vi.spyOn(userInMemory, "updateUserPassword").mockImplementationOnce(() => {
      throw new Error("Database update error");
    });

    await expect(
      resetUserPasswordUseCase.execute({
        token: validToken.token,
        password: "new-password",
      }),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar sua senha! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
