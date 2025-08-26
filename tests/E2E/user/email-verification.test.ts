import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import crypto from "node:crypto";
import { hash } from "bcrypt";

import { serverInstance, app } from "@/http";
import { EmailVerificationUseCase } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-usecase";

import prisma from "infra/database";

let originalExecuteMethod: any;

describe("Email Verification E2E", () => {
  beforeAll(async () => {
    await app.ready();
    originalExecuteMethod = EmailVerificationUseCase.prototype.execute;
  });

  afterEach(() => {
    EmailVerificationUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should verify email successfully", async () => {
    const user = await prisma.user.create({
      data: {
        email: "verification@example.com",
        name: "Verification User",
        password: await hash("1234567", 6),
        role: "BUSINESS_USER",
      },
    });

    const token = crypto.randomBytes(32).toString("hex");

    await prisma.emailVerificationToken.create({
      data: {
        email: user.email,
        token: token,
        expires: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
      },
    });

    const response = await request(serverInstance)
      .post("/user/email-verification")
      .query({ token });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("E-mail confirmado com sucesso!");
  });

  it("should return 400 for missing token", async () => {
    const response = await request(serverInstance).post(
      "/user/email-verification",
    );

    expect(response.statusCode).toEqual(400);
  });

  it("should return 400 for invalid token", async () => {
    const response = await request(serverInstance)
      .post("/user/email-verification")
      .query({ token: "invalid-token" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Token inválido!");
  });

  it("should return 400 for expired token", async () => {
    const user = await prisma.user.create({
      data: {
        email: "expired@example.com",
        name: "Expired User",
        password: await hash("1234567", 6),
        role: "BUSINESS_USER",
      },
    });

    const token = crypto.randomBytes(32).toString("hex");

    await prisma.emailVerificationToken.create({
      data: {
        email: user.email,
        token: token,
        expires: new Date(Date.now() - 1000 * 60), // 1 minute ago (expired)
      },
    });

    const response = await request(serverInstance)
      .post("/user/email-verification")
      .query({ token });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Token expirado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    EmailVerificationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .post("/user/email-verification")
      .query({ token: "some-token" });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
