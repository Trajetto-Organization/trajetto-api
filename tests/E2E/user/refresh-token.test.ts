import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sign } from "jsonwebtoken";

import request from "supertest";

import { createAuthenticateUser } from "@/../utils/tests/create-authenticate-user";
import { app, serverInstance } from "@/http";

import { RefreshTokenUseCase } from "@/modules/user/usecases/refresh-token/refresh-token-usecase";
import { InvalidCredentialsError } from "@/modules/user/usecases/errors/invalid-credentials-error";

import auth from "@/config/auth";
import prisma from "infra/database";

let userAuthenticated: string;
let profileAccessId: string;

let originalExecuteMethod: any;

describe("Refresh token (E2E)", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });

    userAuthenticated = authData.refresh_token;
    profileAccessId = authData.profileAccessId;

    originalExecuteMethod = RefreshTokenUseCase.prototype.execute;
  });

  afterEach(() => {
    RefreshTokenUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should refresh token", async () => {
    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: userAuthenticated });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });

  it("should return 400 if the email in token doesn't match any user", async () => {
    RefreshTokenUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new InvalidCredentialsError();
    });

    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: userAuthenticated });

    expect(response.status).toBe(400);
    expect(response.body.message).toEqual("Credenciais inválidas!");
  });

  it("should return 403 if the user has no profile access or permissions", async () => {
    await prisma.permission.deleteMany({
      where: {
        profileAccessId: profileAccessId,
      },
    });

    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: userAuthenticated });

    expect(response.status).toBe(403);
    expect(response.body.message).toEqual(
      "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
    );
  });

  it("should throw RefreshTokenNotExistsError if refresh token does not exist", async () => {
    const invalidRefreshToken = sign(
      { email: "test@example.com" },
      auth.secret_refresh_token,
      {
        subject: "user-id",
        expiresIn: auth.expires_in_refresh_token,
      },
    );

    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: invalidRefreshToken });

    expect(response.status).toBe(400);
    expect(response.body.message).toEqual("O token de atualização não existe!");
  });

  it("should handle JsonWebTokenError if token is invalid", async () => {
    const invalidRefreshToken = sign({}, auth.secret_token, {
      subject: "user-id",
      expiresIn: auth.expires_in_token,
    });

    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: invalidRefreshToken });

    expect(response.status).toBe(401);
    expect(response.body.message).toEqual("Assinatura de token inválida!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    RefreshTokenUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .post("/user/refresh-token")
      .send({ token: userAuthenticated });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
