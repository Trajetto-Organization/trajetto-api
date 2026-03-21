import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { UserInvalidCredentialsError } from "@/modules/user/usecases/errors/user-invalid-credentials-error";

import { UserNotFoundPermissionOrProfileAccess } from "@/modules/user/usecases/errors/user-not-found-permission-profile-access-error";
import { UserRevokedAccessError } from "@/modules/user/usecases/errors/user-revoked-access-error";

import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { AppError } from "@/shared/errors/AppError";

describe("Authenticate User UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let usersTokensInMemory: InMemoryUserTokensRepository;

  let driverInMemory: InMemoryDriverRepository;
  let authenticateUserUseCase: AuthenticateUserUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUserTokensRepository();

    driverInMemory = new InMemoryDriverRepository();
    authenticateUserUseCase = new AuthenticateUserUseCase(
      userInMemory,
      usersTokensInMemory,
      driverInMemory,
    );
  });

  it("should be able to authenticate", async () => {
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

    user.email_verified = new Date();
    user.two_factor_enabled = false;

    const result = await authenticateUserUseCase.execute({
      email: "user@example.com",
      password,
    });

    expect(result).toHaveProperty("token");
    expect(result).toHaveProperty("refresh_token");

    expect(result.role).toBe(user.role);
  });

  it("should send email verification when email is not verified", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "unverified@example.com",
      password: hashedPassword,
      name: "Unverified User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = null;

    const result = await authenticateUserUseCase.execute({
      email: "unverified@example.com",
      password,
    });

    expect(result).toHaveProperty(
      "emailVerificationMessage",
      "Um token de verificação foi enviado para este e-mail!",
    );
    expect(result).toHaveProperty("emailVerification", true);
  });

  it("should send two-factor code when two-factor is enabled", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "twofactor@example.com",
      password: hashedPassword,
      name: "Two Factor User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = true;

    const result = await authenticateUserUseCase.execute({
      email: "twofactor@example.com",
      password,
    });

    expect(result).toHaveProperty(
      "twoFactorVerificationMessage",
      "Um código de verificação foi enviado para este e-mail!",
    );
    expect(result).toHaveProperty("isTwoFactorVerification", true);
  });

  it("should throw UserRevokedAccessError if user access is revoked", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "revoked@example.com",
      password: hashedPassword,
      name: "Revoked User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.access_revoked = true;

    await expect(
      authenticateUserUseCase.execute({
        email: "revoked@example.com",
        password,
      }),
    ).rejects.toBeInstanceOf(UserRevokedAccessError);
  });

  it("should not be able to authenticate with wrong e-mail", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(() =>
      authenticateUserUseCase.execute({
        email: "test@example.com.br",
        password: "streamlide@2025",
      }),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
  });

  it("should not be able to authenticate with wrong password", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(() =>
      authenticateUserUseCase.execute({
        email: "test@example.com.br",
        password: "user2025",
      }),
    ).rejects.toBeInstanceOf(UserInvalidCredentialsError);
  });

  it("should throw UserNotFoundPermissionOrProfileAccess if BUSINESS_USER does not have profileAccess or permissions", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "nopermission@example.com",
      password: hashedPassword,
      name: "No Permission User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = false;

    user.profileAccess = null;

    await expect(
      authenticateUserUseCase.execute({
        email: "nopermission@example.com",
        password,
      }),
    ).rejects.toBeInstanceOf(UserNotFoundPermissionOrProfileAccess);
  });

  it("should throw AppError if there is an error while creating the user refresh token", async () => {
    vi.spyOn(
      usersTokensInMemory,
      "createUserRefreshToken",
    ).mockImplementationOnce(async () => {
      throw new Error("Token creation failed");
    });

    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "failtoken@example.com",
      password: hashedPassword,
      name: "Fail Token User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = false;

    user.role = "MASTER";

    await expect(
      authenticateUserUseCase.execute({
        email: "failtoken@example.com",
        password,
      }),
    ).rejects.toThrow(AppError);
  });

  it("should throw an error when creating two-factor token fails", async () => {
    vi.spyOn(
      usersTokensInMemory,
      "createTwoFactorToken",
    ).mockImplementationOnce(() => {
      throw new Error("Simulated error in token creation");
    });

    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "fail2fa@example.com",
      password: hashedPassword,
      name: "Fail 2FA User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = true;

    user.role = "MASTER";

    await expect(
      authenticateUserUseCase.execute({
        email: "fail2fa@example.com",
        password,
      }),
    ).rejects.toThrow(AppError);
  });

  it("should delete existing two-factor token if found", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "existing2fa@example.com",
      password: hashedPassword,
      name: "Existing 2FA User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = true;

    user.role = "MASTER";

    const existingToken = {
      email: user.email,
      token: "oldtoken",
      expires: new Date(new Date().getTime() + 15 * 60 * 1000),
    };

    const createTwoFactorToken =
      await usersTokensInMemory.createTwoFactorToken(existingToken);

    const deleteSpy = vi.spyOn(usersTokensInMemory, "deleteTwoFactorToken");

    await authenticateUserUseCase.execute({
      email: "existing2fa@example.com",
      password,
    });

    expect(deleteSpy).toHaveBeenCalledWith(createTwoFactorToken.id);
  });

  it("should delete existing two-factor confirmation if found", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "confirm2fa@example.com",
      password: hashedPassword,
      name: "Confirm 2FA User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = new Date();
    user.two_factor_enabled = true;

    user.role = "MASTER";

    const createConfirmationToken =
      await usersTokensInMemory.createTwoFactorConfirmation(user.id);

    const deleteConfirmationSpy = vi.spyOn(
      usersTokensInMemory,
      "deleteTwoFactorConfirmation",
    );

    await authenticateUserUseCase.execute({
      email: "confirm2fa@example.com",
      password,
    });

    expect(deleteConfirmationSpy).toHaveBeenCalledWith(
      createConfirmationToken.id,
    );
  });

  it("should throw AppError when email verification token creation fails", async () => {
    vi.spyOn(
      usersTokensInMemory,
      "createEmailVerificationToken",
    ).mockImplementationOnce(async () => {
      throw new Error("Email token creation failed");
    });

    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "failemail@example.com",
      password: hashedPassword,
      name: "Fail Email User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = null;

    await expect(
      authenticateUserUseCase.execute({
        email: "failemail@example.com",
        password,
      }),
    ).rejects.toThrow(AppError);
  });

  it("should delete existing email verification token if found", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "existingemail@example.com",
      password: hashedPassword,
      name: "Existing Email User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    user.email_verified = null;

    const existingEmailToken =
      await usersTokensInMemory.createEmailVerificationToken({
        email: user.email,
        token: "oldtoken",
        expires: new Date(new Date().getTime() + 60 * 60 * 1000),
      });

    const deleteSpy = vi.spyOn(
      usersTokensInMemory,
      "deleteEmailVerificationToken",
    );

    await authenticateUserUseCase.execute({
      email: "existingemail@example.com",
      password,
    });

    expect(deleteSpy).toHaveBeenCalledWith(existingEmailToken.id);
  });
});
