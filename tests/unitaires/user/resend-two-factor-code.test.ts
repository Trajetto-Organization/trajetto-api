import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserResendTwoFactorError } from "@/modules/user/usecases/errors/user-resend-two-factor-error";
import { AppError } from "@/shared/errors/AppError";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

describe("Resend Two Factor Code UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let usersTokensInMemory: InMemoryUserTokensRepository;

  let resendTwoFactorCodeUseCase: ResendTwoFactorCodeUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUserTokensRepository();

    resendTwoFactorCodeUseCase = new ResendTwoFactorCodeUseCase(
      userInMemory,
      usersTokensInMemory,
    );
  });

  it("should resend two factor code successfully", async () => {
    const password = await hash("somepass", 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password,
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    user.two_factor_enabled = true;

    await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      token: await hash("123456", 6),
      expires: new Date(Date.now() + 10 * 60 * 1000),
    });

    await usersTokensInMemory.createTwoFactorConfirmation(user.id);
    const response = await resendTwoFactorCodeUseCase.execute(user.email);

    expect(response).toEqual({
      twoFactorVerificationMessage:
        "Um código de verificação foi reenviado para este e-mail!",
    });

    const tokenAfter = await usersTokensInMemory.findTwoFactorTokenByEmail(
      user.email,
    );

    expect(tokenAfter).toMatchObject({
      email: "user@example.com",
      token: expect.any(String),
      id: expect.any(String),
      expires: expect.any(Date),
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      resendTwoFactorCodeUseCase.execute("nonexistent@example.com"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ResendTwoFactorError if two_factor is not enabled", async () => {
    const password = await hash("somepass", 6);
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password,
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      resendTwoFactorCodeUseCase.execute(user.email),
    ).rejects.toBeInstanceOf(UserResendTwoFactorError);
  });

  it("should throw AppError if an error occurs while sending the two factor code", async () => {
    const password = await hash("somepass", 6);
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password,
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    user.two_factor_enabled = true;

    vi.spyOn(
      usersTokensInMemory,
      "createTwoFactorToken",
    ).mockImplementationOnce(async () => {
      throw new Error("Simulated token creation error");
    });

    await expect(
      resendTwoFactorCodeUseCase.execute(user.email),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
