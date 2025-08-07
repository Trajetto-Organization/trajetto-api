import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import prisma from "infra/database";

import { v4 as uuidV4 } from "uuid";
import { hash } from "bcrypt";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { ForgotPasswordVerificationUseCase } from "@/modules/user/usecases/forgot-password-verification/forgot-password-verification-usecase";

let token: string;
let randomEmail: string;

let originalExecuteMethod: any;

describe("Forgot password verification (E2E)", () => {
  beforeEach(async () => {
    await app.ready();

    token = uuidV4();
    randomEmail = `test${uuidV4()}@example.com`;

    originalExecuteMethod = ForgotPasswordVerificationUseCase.prototype.execute;
  });

  afterEach(() => {
    ForgotPasswordVerificationUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to verify the token successfully", async () => {
    const userCreated = await prisma.user.create({
      data: {
        email: randomEmail,
        name: "Test User",
        password: await hash("1234567", 6),
        role: "MASTER",
      },
    });

    const passwordVerificationToken =
      await prisma.forgotPasswordVerificationToken.create({
        data: {
          email: userCreated.email,
          token,
          expires: new Date(Date.now() + 1000 * 60 * 15), // expires in 15 minutes
        },
      });

    const response = await request(serverInstance)
      .get("/user/forgot-verification")
      .query({ token: passwordVerificationToken.token });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toEqual(
      'Token "esqueci minha senha" confirmada com sucesso!',
    );
  });

  it("should not be able to verify with an invalid token", async () => {
    const response = await request(serverInstance)
      .get("/user/forgot-verification")
      .query({ token: "invalid-token" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Token inválido!");
  });

  it("should throw ExpiredTokenError if token has expired", async () => {
    const userCreated = await prisma.user.create({
      data: {
        email: randomEmail,
        name: "Test User",
        password: await hash("1234567", 6),
        role: "BUSINESS_USER",
      },
    });

    const passwordVerificationToken =
      await prisma.forgotPasswordVerificationToken.create({
        data: {
          email: userCreated.email,
          token,
          expires: new Date(Date.now() - 1000 * 60 * 15), // expires in 15 minutes
        },
      });

    const response = await request(serverInstance)
      .get("/user/forgot-verification")
      .query({ token: passwordVerificationToken.token });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toEqual("Token expirado!");
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const passwordVerificationToken =
      await prisma.forgotPasswordVerificationToken.create({
        data: {
          email: randomEmail,
          token,
          expires: new Date(Date.now() + 1000 * 60 * 15), // expires in 15 minutes
        },
      });

    const response = await request(serverInstance)
      .get("/user/forgot-verification")
      .query({ token: passwordVerificationToken.token });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toEqual("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ForgotPasswordVerificationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .get("/user/forgot-verification")
      .query({ token: "invalid-token" });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
