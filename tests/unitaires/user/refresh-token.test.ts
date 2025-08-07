import { describe, it, expect, beforeEach, vi } from "vitest";
import { sign, JsonWebTokenError } from "jsonwebtoken";

import { hash } from "bcrypt";
import auth from "@/config/auth";

import { RefreshTokenUseCase } from "@/modules/user/usecases/refresh-token/refresh-token-usecase";
import { RefreshTokenNotExistsError } from "@/modules/user/usecases/errors/refresh-token-not-exists-error";

import { InMemoryUsersTokens } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { InMemoryMailProvider } from "@/shared/providers/mail-provider/in-memory/in-memory-mail-provider";

import { UserNotFoundPermissionOrProfileAccess } from "@/modules/user/usecases/errors/user-not-found-permission-profile-access-error";
import { InvalidCredentialsError } from "@/modules/user/usecases/errors/invalid-credentials-error";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let authenticateUserUseCase: AuthenticateUserUseCase;

let mailProvider: InMemoryMailProvider;
let usersTokensInMemory: InMemoryUsersTokens;

let refreshTokenUseCase: RefreshTokenUseCase;

describe("Refresh Token UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUsersTokens();

    refreshTokenUseCase = new RefreshTokenUseCase(
      userInMemory,
      usersTokensInMemory,
    );
    mailProvider = new InMemoryMailProvider();

    authenticateUserUseCase = new AuthenticateUserUseCase(
      userInMemory,
      mailProvider,
      usersTokensInMemory,
    );
  });

  it("should be able to refresh token", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const userCreated = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    userCreated.role = "MASTER";

    const user = await authenticateUserUseCase.execute({
      email: "user@example.com",
      password: "password123",
    });

    const { refresh_token, token } = await refreshTokenUseCase.execute(
      user.refresh_token as string,
    );

    expect(refresh_token).toEqual(expect.any(String));
    expect(token).toEqual(expect.any(String));
  });

  it("should throw InvalidCredentialsError if user is not found", async () => {
    const nonExistentEmail = "nonexistent@example.com";
    const token = sign({ email: nonExistentEmail }, auth.secret_refresh_token, {
      subject: "nonexistent-id",
      expiresIn: auth.expires_in_refresh_token,
    });

    await expect(refreshTokenUseCase.execute(token)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("should throw UserNotFoundPermissionOrProfileAccess if BUSINESS_USER lacks profileAccess or permissions", async () => {
    const user = await userInMemory.createUser({
      email: "businessuser@example.com",
      password: "hashedpassword",
      name: "Business User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "BUSINESS_USER",
    });

    user.profileAccess = {
      name: "Acesso",
      permissions: [],
    };

    const token = sign({ email: user.email }, auth.secret_refresh_token, {
      subject: user.id,
      expiresIn: auth.expires_in_refresh_token,
    });

    vi.spyOn(
      usersTokensInMemory,
      "findUserTokenByIdAndRefreshToken",
    ).mockResolvedValue({
      id: "token-id",
      userId: user.id,
      refresh_token: token,
      expires_in: new Date(Date.now() + 3600000),
    });

    await expect(refreshTokenUseCase.execute(token)).rejects.toBeInstanceOf(
      UserNotFoundPermissionOrProfileAccess,
    );
  });

  it("should throw RefreshTokenNotExistsError if refresh token does not exist", async () => {
    const user = await userInMemory.createUser({
      email: "user2@example.com",
      password: "hashedpassword",
      name: "Jane Doe",
      businessId: "business2",
      profileAccessId: "profile2",
      role: "MASTER",
    });

    const token = sign({ email: user.email }, auth.secret_refresh_token, {
      subject: user.id,
      expiresIn: auth.expires_in_refresh_token,
    });

    await expect(refreshTokenUseCase.execute(token)).rejects.toBeInstanceOf(
      RefreshTokenNotExistsError,
    );
  });

  it("should handle JsonWebTokenError if token is invalid", async () => {
    const invalidRefreshToken = sign({}, auth.secret_token, {
      subject: "user-id",
      expiresIn: auth.expires_in_token,
    });

    await expect(
      refreshTokenUseCase.execute(invalidRefreshToken),
    ).rejects.toBeInstanceOf(JsonWebTokenError);
  });

  it("should throw an AppError if refresh token throws an error", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      businessId: "business-id",
      profileAccessId: "profile-id",
      role: "MASTER",
    });

    user.role = "MASTER";
    const userId = user.id;

    const validToken = sign({ email: user.email }, auth.secret_refresh_token, {
      subject: userId,
      expiresIn: auth.expires_in_refresh_token,
    });

    vi.spyOn(
      usersTokensInMemory,
      "findUserTokenByIdAndRefreshToken",
    ).mockResolvedValue({
      id: "token-id",
      userId,
      refresh_token: validToken,
      expires_in: new Date(Date.now() + 1000 * 60 * 60),
    });

    vi.spyOn(
      usersTokensInMemory,
      "createUserRefreshToken",
    ).mockImplementationOnce(() => {
      throw new Error("Database error");
    });

    await expect(refreshTokenUseCase.execute(validToken)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar entrar na sua conta! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
