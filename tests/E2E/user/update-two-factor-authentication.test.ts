import { expect, describe, it, vi, beforeAll, afterEach } from "vitest";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { UpdateTwoFactorAuthenticationUseCase } from "@/modules/user/usecases/update-two-factor-authentication/update-two-factor-authentication-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Update two factor authentication (E2E)", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod =
      UpdateTwoFactorAuthenticationUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateTwoFactorAuthenticationUseCase.prototype.execute =
      originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update two factor authentication", async () => {
    const response = await request(serverInstance)
      .patch("/user/twofactor")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send();

    expect(response.statusCode).toBe(200);
    expect(response.body.message).toEqual(
      "Autenticação de dois fatores atualizada com sucesso!",
    );
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    UpdateTwoFactorAuthenticationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch("/user/twofactor")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send();

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateTwoFactorAuthenticationUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch("/user/twofactor")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send();

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
