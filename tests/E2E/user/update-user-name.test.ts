import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { UpdateUserNameUseCase } from "@/modules/user/usecases/update-user-name/update-user-name-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import prisma from "infra/database";

let userAuthenticated: string;
let userId: string;

let originalExecuteMethod: any;

describe("Update Username E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    userId = authData.userId;

    originalExecuteMethod = UpdateUserNameUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateUserNameUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should update username successfully", async () => {
    const newName = "Updated Test User";

    const response = await request(serverInstance)
      .patch("/user/username")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ name: newName });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Nome de usuário atualizado com sucesso",
    );

    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(updatedUser?.name).toEqual(newName);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateUserNameUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .patch("/user/username")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ name: "Any New Name" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw UserNameNotBeUpdatedError if new name is same as current", async () => {
    const response = await request(serverInstance)
      .patch("/user/username")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ name: "Updated Test User" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Para atualizar, o novo nome deve ser diferente do atual",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateUserNameUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .patch("/user/username")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ name: "New Name" });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
