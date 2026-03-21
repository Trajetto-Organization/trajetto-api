import { describe, it, beforeEach, expect, vi } from "vitest";

import crypto from "node:crypto";
import bcrypt, { hash } from "bcrypt";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";
import { UserExpiredCodeError } from "@/modules/user/usecases/errors/user-expired-code-error";

import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { UserInvalidTwoFactorCodeError } from "@/modules/user/usecases/errors/user-invalid-two-factor-code-error";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;

let usersTokensInMemory: InMemoryUserTokensRepository;
let twoFactorVerificationUseCase: TwoFactorVerificationUseCase;

let twoFactorToken: string;

describe("Two factor Verification Vode UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUserTokensRepository();

    twoFactorVerificationUseCase = new TwoFactorVerificationUseCase(
      userInMemory,
      usersTokensInMemory,
    );

    twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
  });

  it("should verify the two factor with a valid code", async () => {
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

    user.role = "MASTER";
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      expires: new Date(new Date().getTime() + 15 * 60 * 1000), // 15 minutes from now
      token: hashedTwoFactorToken,
    });

    const response = await twoFactorVerificationUseCase.execute({
      email: user.email,
      twoFactorCode: twoFactorToken,
    });

    expect(response).toEqual({
      token: expect.any(String),
      role: "MASTER",
      refresh_token: expect.any(String),
    });
  });

  it("should throw ResourceNotFoundError if the two-factor email is not provided", async () => {
    await expect(
      twoFactorVerificationUseCase.execute({
        twoFactorCode: twoFactorToken,
        email: "",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ResourceNotFoundError if no user is found with the two-factor token email", async () => {
    const storedToken = await bcrypt.hash("123456", 6);
    const twoFactorTokenEmail = "non-existent@example.com";

    vi.spyOn(
      usersTokensInMemory,
      "findTwoFactorTokenByEmail",
    ).mockResolvedValueOnce({
      id: "some-id",
      email: twoFactorTokenEmail,
      token: storedToken,
      expires: new Date(Date.now() + 1000 * 60 * 10),
    });

    vi.spyOn(userInMemory, "findUserByEmail").mockResolvedValueOnce(null);

    await expect(
      twoFactorVerificationUseCase.execute({
        twoFactorCode: "123456",
        email: twoFactorTokenEmail,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw InvalidTwoFactorCodeError if the two-factor code is invalid", async () => {
    await expect(
      twoFactorVerificationUseCase.execute({
        twoFactorCode: twoFactorToken,
        email: "non-existent@example.com",
      }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
  });

  it("should throw InvalidTwoFactorCodeError if the provided two-factor code does not match the stored code", async () => {
    const storedToken = "stored-token-hash";

    // Mock the findTwoFactorTokenByEmail method to return a fake token
    vi.spyOn(
      usersTokensInMemory,
      "findTwoFactorTokenByEmail",
    ).mockResolvedValueOnce({
      id: "some-id",
      email: "existent@example.com",
      token: storedToken,
      expires: new Date(Date.now() + 1000 * 60 * 10),
    });

    // Mock the findUserByEmail method to return a fake user
    vi.spyOn(userInMemory, "findUserByEmail").mockResolvedValueOnce({
      id: "user-1",
      email: "existent@example.com",
      name: "User Test",
      password: "user@1234567",
      role: "MASTER",
      access_revoked: false,
    });

    // Mock the compare function to return false
    vi.spyOn(bcrypt, "compare").mockImplementationOnce(async () => false);

    await expect(
      twoFactorVerificationUseCase.execute({
        twoFactorCode: "123456",
        email: "existent@example.com",
      }),
    ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
  });

  it("should delete existing two-factor confirmation if it exists", async () => {
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

    user.role = "MASTER";
    const hashedTwoFactorToken = await bcrypt.hash(twoFactorToken, 6);

    await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      expires: new Date(new Date().getTime() + 15 * 60 * 1000), // 15 minutes from now
      token: hashedTwoFactorToken,
    });

    await usersTokensInMemory.createTwoFactorConfirmation(user.id);

    const response = await twoFactorVerificationUseCase.execute({
      email: user.email,
      twoFactorCode: twoFactorToken,
    });

    expect(response).toEqual({
      token: expect.any(String),
      role: "MASTER",
      refresh_token: expect.any(String),
    });
  });

  it("should throw ExpiredCodeError if the code has expired", async () => {
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

    const hashedTwoFactorToken = await bcrypt.hash(twoFactorToken, 6);

    const expiredToken = await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      expires: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
      token: hashedTwoFactorToken,
    });

    await expect(
      twoFactorVerificationUseCase.execute({
        twoFactorCode: twoFactorToken,
        email: expiredToken.email,
      }),
    ).rejects.toBeInstanceOf(UserExpiredCodeError);
  });

  it("should throw AppError if creating user refresh token fails", async () => {
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

    user.role = "MASTER";
    const hashedTwoFactorToken = await bcrypt.hash(twoFactorToken, 6);

    await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      expires: new Date(new Date().getTime() + 15 * 60 * 1000), // 15 minutes from now
      token: hashedTwoFactorToken,
    });

    // Simulates failure to create a refresh token
    vi.spyOn(
      usersTokensInMemory,
      "createUserRefreshToken",
    ).mockImplementationOnce(() => {
      throw new Error("Database error");
    });

    await expect(
      twoFactorVerificationUseCase.execute({
        email: user.email,
        twoFactorCode: twoFactorToken,
      }),
    ).rejects.toThrowError(
      new AppError(
        "Houve um erro ao tentar entrar na sua conta! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should throw AppError if creating two-factor confirmation fails", async () => {
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

    const hashedTwoFactorToken = await bcrypt.hash(twoFactorToken, 6);

    await usersTokensInMemory.createTwoFactorToken({
      email: user.email,
      expires: new Date(new Date().getTime() + 15 * 60 * 1000), // 15 minutes from now
      token: hashedTwoFactorToken,
    });

    // Simulates failure when creating two-factor confirmation
    vi.spyOn(
      usersTokensInMemory,
      "createTwoFactorConfirmation",
    ).mockImplementationOnce(() => {
      throw new Error("Database error");
    });

    await expect(
      twoFactorVerificationUseCase.execute({
        email: user.email,
        twoFactorCode: twoFactorToken,
      }),
    ).rejects.toThrowError(
      new AppError(
        "Houve um erro ao tentar confirmar a sua verificação de dois fatores! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
