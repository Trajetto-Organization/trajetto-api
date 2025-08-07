import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DeleteUserUseCase } from "@/modules/user/usecases/delete-user/delete-user-usecase";

import prisma from "infra/database";
import { hash } from "bcrypt";

let userAuthenticated: string;
let userId: string;

let originalExecuteMethod: any;

describe("Delete User E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "user_registration_manage",
    });

    userAuthenticated = authData.token;
    userId = authData.userId;

    originalExecuteMethod = DeleteUserUseCase.prototype.execute;
  });

  afterEach(() => {
    DeleteUserUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a user", async () => {
    const targetPassword = "target123";
    const hashedTargetPassword = await hash(targetPassword, 6);

    const targetUser = await prisma.user.create({
      data: {
        email: "target@example.com",
        name: "Target User",
        password: hashedTargetPassword,
        role: "BUSINESS_USER",
      },
    });

    const response = await request(serverInstance)
      .delete(`/user/delete-user/${targetUser.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Usuário deletado com sucesso!");
  });

  it("should throw UserCannotBeDeletedByHimselfError if the user tries to delete their own user", async () => {
    const response = await request(serverInstance)
      .delete(`/user/delete-user/${userId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para deletar o seu próprio usuário.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeleteUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .delete("/user/delete-user/non-user-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeleteUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .delete("/user/delete-user/non-user-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
