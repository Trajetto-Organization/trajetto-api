import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { hash } from "bcrypt";
import { v4 as uuidV4 } from "uuid";

import request from "supertest";
import prisma from "infra/database";

import { serverInstance, app } from "@/http";
import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";

let randomEmail: string;
let originalExecuteMethod: any;

describe("Send forgot password mail (E2E)", () => {
  beforeEach(async () => {
    await app.ready();
    randomEmail = `test${uuidV4()}@gmail.com`;

    originalExecuteMethod = SendForgotPasswordMailUseCase.prototype.execute;
  });

  afterEach(() => {
    SendForgotPasswordMailUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to send a forgot password mail to user", async () => {
    await prisma.user.create({
      data: {
        email: randomEmail,
        name: "Test User",
        password: await hash("1234567", 6),
        role: "MASTER",
      },
    });

    const response = await request(serverInstance)
      .post("/user/forgot/password")
      .send({
        email: randomEmail,
      });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
    );
  });

  it("should not be able to send an e-mail if user does not exists", async () => {
    const response = await request(serverInstance)
      .post("/user/forgot/password")
      .send({
        email: randomEmail,
      });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    SendForgotPasswordMailUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .post("/user/forgot/password")
      .send({
        email: randomEmail,
      });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  }, 15000);
});
