import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { UpdateUserPasswordUseCase } from "@/modules/user/usecases/update-user-password/update-user-password-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Update User Password (e2e)", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = UpdateUserPasswordUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateUserPasswordUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should update the password successfully", async () => {
    const response = await request(serverInstance)
      .patch("/user/password")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        currentPassword: "1234567",
        newPassword: "newsecurepassword",
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("Senha atualizada com sucesso");
  });

  it("should not update password if current password is incorrect", async () => {
    const response = await request(serverInstance)
      .patch("/user/password")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        currentPassword: "wrongpassword",
        newPassword: "newsecurepassword",
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe("Senha atual incorreta");
  });

  it("should not update if new password is the same as current", async () => {
    const response = await request(serverInstance)
      .patch("/user/password")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        currentPassword: "newsecurepassword",
        newPassword: "newsecurepassword",
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toBe(
      "A nova senha não pode ser igual à senha atual",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateUserPasswordUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch("/user/password")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        currentPassword: "1234567",
        newPassword: "newsecurepassword",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateUserPasswordUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch("/user/password")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        currentPassword: "1234567",
        newPassword: "newsecurepassword",
      });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
