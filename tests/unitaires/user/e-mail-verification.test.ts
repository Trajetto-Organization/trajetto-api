import { describe, it, expect, beforeEach, vi } from "vitest";

import { EmailVerificationUseCase } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserInvalidTokenError } from "@/modules/user/usecases/errors/user-invalid-token-error";
import { UserExpiredTokenError } from "@/modules/user/usecases/errors/user-expired-token-error";

import { UserMissingTokenError } from "@/modules/user/usecases/errors/user-missing-token-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { AppError } from "@/shared/errors/AppError";

describe("Email Verification UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let userTokensInMemory: InMemoryUserTokensRepository;

  let emailVerificationUseCase: EmailVerificationUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    userTokensInMemory = new InMemoryUserTokensRepository();

    emailVerificationUseCase = new EmailVerificationUseCase(
      userInMemory,
      userTokensInMemory,
    );
  });

  it("should be able to verify user email with valid token", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 1);

    const emailToken = await userTokensInMemory.createEmailVerificationToken({
      email: user.email,
      token: "test-token",
      expires: futureDate,
    });

    await emailVerificationUseCase.execute(emailToken.token);

    const updatedUser = await userInMemory.findUserByEmail(user.email);
    expect(updatedUser?.email_verified).toBeDefined();

    const tokenAfterVerification =
      await userTokensInMemory.findEmailVerificationTokenByToken(
        emailToken.token,
      );
    expect(tokenAfterVerification).toBeNull();
  });

  it("should throw MissingTokenError if token is not provided", async () => {
    await expect(emailVerificationUseCase.execute("")).rejects.toBeInstanceOf(
      UserMissingTokenError,
    );

    await expect(
      emailVerificationUseCase.execute(null as any),
    ).rejects.toBeInstanceOf(UserMissingTokenError);

    await expect(
      emailVerificationUseCase.execute(undefined as any),
    ).rejects.toBeInstanceOf(UserMissingTokenError);
  });

  it("should throw InvalidTokenError if token does not exist", async () => {
    await expect(
      emailVerificationUseCase.execute("non-existent-token"),
    ).rejects.toBeInstanceOf(UserInvalidTokenError);
  });

  it("should throw ExpiredTokenError if token has expired", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const pastDate = new Date();
    pastDate.setHours(pastDate.getHours() - 1);

    const expiredToken = await userTokensInMemory.createEmailVerificationToken({
      email: user.email,
      token: "expired-test-token",
      expires: pastDate,
    });

    await expect(
      emailVerificationUseCase.execute(expiredToken.token),
    ).rejects.toBeInstanceOf(UserExpiredTokenError);
  });

  it("should throw ResourceNotFoundError if user associated with token does not exist", async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 1);

    const emailToken = await userTokensInMemory.createEmailVerificationToken({
      email: "non-existent@example.com",
      token: "test-token",
      expires: futureDate,
    });

    await expect(
      emailVerificationUseCase.execute(emailToken.token),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if an error occurs during verification process", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 1);

    const emailToken = await userTokensInMemory.createEmailVerificationToken({
      email: user.email,
      token: "test-token",
      expires: futureDate,
    });

    vi.spyOn(userInMemory, "updateEmailVerification").mockImplementationOnce(
      async () => {
        throw new Error("Database error");
      },
    );

    await expect(
      emailVerificationUseCase.execute(emailToken.token),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar verificar o seu e-mail! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
