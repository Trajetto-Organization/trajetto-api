import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";

import crypto from "node:crypto";
import request from "supertest";

import { serverInstance, app } from "@/http";
import prisma from "infra/database";

import { hash } from "bcrypt";

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Authenticate user (E2E)", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = AuthenticateUserUseCase.prototype.execute;
  });

  afterEach(() => {
    AuthenticateUserUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to authenticate", async () => {
    const response = await request(serverInstance).post("/user/session").send({
      email: "test@example.com",
      password: "1234567",
    });

    expect(response.statusCode).toEqual(200);
    expect(response.body).toEqual({
      message: expect.any(String),
      token: expect.any(String),
      role: "BUSINESS_USER",
      refresh_token: expect.any(String),
    });
  });

  it("should be able to authenticate with two-factor enabled", async () => {
    const userProfileResponse = await request(serverInstance)
      .get("/user/me")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send();

    const { id, email } = userProfileResponse.body.user;

    await prisma.user.update({
      where: {
        id: id,
      },
      data: {
        two_factor_enabled: true,
      },
    });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    await prisma.twoFactorToken.create({
      data: {
        email: email,
        expires: new Date(Date.now() + 1000 * 60 * 15), // 15 minutes from now,
        token: hashedTwoFactorToken,
      },
    });

    const response = await request(serverInstance)
      .post("/user/two-factor-verification")
      .send({
        email: "test@example.com",
        code: twoFactorToken,
      });

    expect(response.statusCode).toEqual(200);
    expect(response.body).toEqual({
      message: expect.any(String),
      token: expect.any(String),
      refresh_token: expect.any(String),
      role: "BUSINESS_USER",
    });
  });

  it("should not be able to authenticate without two factor code", async () => {
    const userResponse = await request(serverInstance)
      .get("/user/me")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send();

    const { id, email } = userResponse.body.user;

    await prisma.user.update({
      where: {
        id: id,
      },
      data: {
        two_factor_enabled: true,
      },
    });

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = await hash(twoFactorToken, 6);

    await prisma.twoFactorToken.create({
      data: {
        email: email,
        expires: new Date(Date.now() + 1000 * 60 * 15), // 15 minutes from now,
        token: hashedTwoFactorToken,
      },
    });

    const response = await request(serverInstance).post("/user/session").send({
      email: "test@example.com",
      password: "1234567",
    });

    expect(response.statusCode).toEqual(200);
    expect(response.body).toEqual({
      message: "Um código de verificação foi enviado para este e-mail!",
      twoFactorVerification: true,
    });
  });

  it("should not be able to authenticate with invalid credentials", async () => {
    const response = await request(serverInstance).post("/user/session").send({
      email: "test@example.com",
      password: "12345678",
    });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toEqual("Credenciais inválidas!");
  });

  it("should return 403 if the user has no profile access or permissions", async () => {
    await prisma.user.create({
      data: {
        email: "authenticatetest@example.com",
        name: "New User Test",
        role: "BUSINESS_USER",
        password: await hash("1234567", 6),
      },
    });

    const response = await request(serverInstance).post("/user/session").send({
      email: "authenticatetest@example.com",
      password: "1234567",
    });

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toEqual(
      "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
    );
  });

  it("should throw Internal Server Error if an unknown error occurs", async () => {
    AuthenticateUserUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance).post("/user/session").send({
      email: "test@example.com",
      password: "1234567",
    });

    expect(response.statusCode).toEqual(500);

    expect(response.body).toHaveProperty("message");
    expect(response.body.message).toEqual("Internal server error");
  });
});
