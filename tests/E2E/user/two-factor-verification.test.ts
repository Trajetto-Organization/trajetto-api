import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { hash } from "bcrypt";

import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { InvalidCodeForUserError } from "@/modules/user/usecases/errors/invalid-code-for-user-error";

import prisma from "infra/database";

let userId: string;
let profileAccessId: string;

let originalExecuteMethod: any;

describe("Two Factor Verification (E2E)", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });

    userId = authData.userId;
    profileAccessId = authData.profileAccessId;

    originalExecuteMethod = TwoFactorVerificationUseCase.prototype.execute;
  });

  afterEach(() => {
    TwoFactorVerificationUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should verify the two-factor authentication successfully", async () => {
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        two_factor_enabled: true,
      },
    });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    await prisma.twoFactorToken.upsert({
      where: {
        email: "test@example.com",
      },
      create: {
        email: "test@example.com",
        expires: new Date(Date.now() + 1000 * 60 * 15),
        token: hashedTwoFactorToken,
      },
      update: {
        token: hashedTwoFactorToken,
        expires: new Date(Date.now() + 1000 * 60 * 15),
      },
    });

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Autenticação de dois fatores bem-sucedida!",
    );
  });

  it("should return 403 if the user has no profile access or permissions", async () => {
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        two_factor_enabled: true,
      },
    });

    await prisma.permission.deleteMany({
      where: {
        profileAccessId: profileAccessId,
      },
    });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    await prisma.twoFactorToken.upsert({
      where: {
        email: "test@example.com",
      },
      create: {
        email: "test@example.com",
        expires: new Date(Date.now() + 1000 * 60 * 15),
        token: hashedTwoFactorToken,
      },
      update: {
        token: hashedTwoFactorToken,
        expires: new Date(Date.now() + 1000 * 60 * 15),
      },
    });

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
    );
  });

  it("should throw InvalidTwoFactorCodeError if the two-factor code is invalid", async () => {
    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Código inválido!");
  });

  it("should throw ExpiredCodeError if the code has expired", async () => {
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        two_factor_enabled: true,
      },
    });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    // Updating or deleting the previous token if it exists
    await prisma.twoFactorToken.upsert({
      where: {
        email: "test@example.com",
      },
      create: {
        email: "test@example.com",
        expires: new Date(Date.now() - 1000 * 60 * 15), // expires in 15 minutes
        token: hashedTwoFactorToken,
      },
      update: {
        token: hashedTwoFactorToken,
        expires: new Date(Date.now() - 1000 * 60 * 15), // expires in 15 minutes
      },
    });

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Código expirado!");
  });

  it("should throw ResourceNotFoundError if the two-factor email is not provided", async () => {
    TwoFactorVerificationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "twofactor@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw InvalidCodeForUserError if the email doesn't match the token's email", async () => {
    TwoFactorVerificationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new InvalidCodeForUserError();
      });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "wrong@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Código inválido para o usuário!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    TwoFactorVerificationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
