import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcrypt";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { ResendTwoFactorCodeUseCase } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-usecase";
import prisma from "infra/database";

vi.mock("@/modules/middlewares/rate-limiter", () => ({
  getRateLimiterConfig: () => ({
    max: 5,
    timeWindow: 60 * 1000,
    skip: () => true,
  }),
}));

let originalExecuteMethod: any;

describe("Refresh token (E2E)", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";

    await app.ready();
    originalExecuteMethod = ResendTwoFactorCodeUseCase.prototype.execute;
  });

  afterEach(() => {
    ResendTwoFactorCodeUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should resend the two-factor authentication code successfully", async () => {
    await prisma.user.create({
      data: {
        email: "admin@example.com",
        password: await hash("adminpass", 6),
        name: "Admin User",
        role: "MASTER",
        two_factor_enabled: true,
      },
    });

    const response = await request(serverInstance)
      .post("/user/resend-two-factor-code")
      .send({ email: "admin@example.com" });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Um código de verificação foi reenviado para este e-mail!",
    );
  });

  it("should throw ResendTwoFactorError", async () => {
    await prisma.user.create({
      data: {
        email: "newadmin@example.com",
        password: await hash("adminpass", 6),
        name: "Admin User",
        role: "MASTER",
      },
    });

    const response = await request(serverInstance)
      .post("/user/resend-two-factor-code")
      .send({ email: "newadmin@example.com" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const response = await request(serverInstance)
      .post("/user/resend-two-factor-code")
      .send({ email: "test@example.com" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ResendTwoFactorCodeUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .post("/user/resend-two-factor-code")
      .send({ email: "test@example.com" });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
