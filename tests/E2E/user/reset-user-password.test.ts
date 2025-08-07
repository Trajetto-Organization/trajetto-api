import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import prisma from "infra/database";

import { v4 as uuidV4 } from "uuid";
import { hash, compare } from "bcrypt";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";

let token: string;
let randomEmail: string;

let originalExecuteMethod: any;

describe("Reset password (E2E)", () => {
  beforeEach(async () => {
    await app.ready();

    token = uuidV4();
    randomEmail = `test${uuidV4()}@example.com`;

    originalExecuteMethod = ResetUserPasswordUseCase.prototype.execute;
  });

  afterEach(() => {
    ResetUserPasswordUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should reset password with a valid token", async () => {
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
      .post("/user/reset/password")
      .send({
        password: "123456789",
      })
      .query({ token: passwordVerificationToken.token });

    const updatedUserPassword = await prisma.user.findUnique({
      where: {
        email: randomEmail,
      },
    });

    expect(
      await compare("1234567", updatedUserPassword?.password as string),
    ).toBe(false); // Ensure new password is different from the old one

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toEqual("Senha redefinida com sucesso!");
  });

  it("should throw InvalidTokenError if token does not exist", async () => {
    const response = await request(serverInstance)
      .post("/user/reset/password")
      .send({
        password: "1234567",
      })
      .query({ token: "invalid-token" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Token inválido!");
  });

  it("should throw ExpiredTokenError if token has expired", async () => {
    const userCreated = await prisma.user.create({
      data: {
        email: randomEmail,
        name: "StreamLide API",
        password: await hash("1234567", 6),
        role: "MASTER",
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
      .post("/user/reset/password")
      .send({
        password: "1234567",
      })
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
      .post("/user/reset/password")
      .send({
        password: "1234567",
      })
      .query({ token: passwordVerificationToken.token });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toEqual("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ResetUserPasswordUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const passwordVerificationToken =
      await prisma.forgotPasswordVerificationToken.create({
        data: {
          email: randomEmail,
          token,
          expires: new Date(Date.now() + 1000 * 60 * 15), // expires in 15 minutes
        },
      });

    const response = await request(serverInstance)
      .post("/user/reset/password")
      .send({
        password: "1234567",
      })
      .query({ token: passwordVerificationToken.token });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  }, 15000);
});
