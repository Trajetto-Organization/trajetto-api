import { expect, it, describe, beforeEach } from "vitest";
import { hash } from "bcrypt";

import { v4 as uuidV4 } from "uuid";

import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ForgotPasswordVerificationUseCase } from "@/modules/user/usecases/forgot-password-verification/forgot-password-verification-usecase";
import { UserInvalidTokenError } from "@/modules/user/usecases/errors/user-invalid-token-error";

import { UserExpiredTokenError } from "@/modules/user/usecases/errors/user-expired-token-error";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userInMemory: InMemoryUserRepository;
let usersTokensInMemory: InMemoryUserTokensRepository;

let forgotPasswordVerificationUseCase: ForgotPasswordVerificationUseCase;
let token: string;

describe("Forgot Password Verification UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUserTokensRepository();

    forgotPasswordVerificationUseCase = new ForgotPasswordVerificationUseCase(
      userInMemory,
      usersTokensInMemory,
    );
    token = uuidV4();
  });

  it("should be able to verify the token successfully", async () => {
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
        expires: new Date(Date.now() + 1000 * 60 * 15), // 15 minutos a partir de agora
      });

    await expect(
      forgotPasswordVerificationUseCase.execute(validToken.token),
    ).resolves.not.toThrow();
  });

  it("should not be able to verify with an invalid token", async () => {
    await expect(
      forgotPasswordVerificationUseCase.execute(token),
    ).rejects.toBeInstanceOf(UserInvalidTokenError);
  });

  it("should throw ExpiredTokenError if token has expired", async () => {
    const expiredToken =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: "user@example.com",
        expires: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
      });

    await expect(
      forgotPasswordVerificationUseCase.execute(expiredToken.token),
    ).rejects.toBeInstanceOf(UserExpiredTokenError);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const findUser =
      await usersTokensInMemory.createForgotPasswordVerificationToken({
        token,
        email: "user@example.com",
        expires: new Date(Date.now() + 1000 * 60 * 15), //15 minutes from now
      });

    await expect(
      forgotPasswordVerificationUseCase.execute(findUser.token),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
