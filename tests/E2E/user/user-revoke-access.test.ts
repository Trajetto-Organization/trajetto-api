import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";

import request from "supertest";
import { hash } from "bcrypt";

import { serverInstance, app } from "@/http";

import { createAuthenticateUser } from "utils/tests/create-authenticate-user";
import { UserRevokeAccessUseCase } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-usecase";

import prisma from "infra/database";

let userAuthenticated: string;
let userId: string;

let originalExecuteMethod: any;

describe("User Revoke Access E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    userId = authData.userId;

    originalExecuteMethod = UserRevokeAccessUseCase.prototype.execute;
  });

  afterEach(() => {
    UserRevokeAccessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should revoke user access successfully", async () => {
    const targetUser = await prisma.user.create({
      data: {
        email: "target@example.com",
        name: "Target User",
        role: "BUSINESS_USER",
        password: await hash("1234567", 6),
        email_verified: new Date(),
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/revoke-access/${targetUser.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Revogação de acesso atualizada com sucesso!",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const response = await request(serverInstance)
      .patch(`/user/revoke-access/userId`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should return 403 if user tries to revoke own access", async () => {
    const response = await request(serverInstance)
      .patch(`/user/revoke-access/${userId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para revogar o seu próprio acesso.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UserRevokeAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error("Unexpected error");
      });

    const targetUser = await prisma.user.create({
      data: {
        email: "error@example.com",
        name: "Error User",
        role: "BUSINESS_USER",
        password: await hash("1234567", 6),
        email_verified: new Date(),
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/revoke-access/${targetUser.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
