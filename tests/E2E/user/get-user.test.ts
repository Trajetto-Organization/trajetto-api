import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { GetUserUseCase } from "@/modules/user/usecases/get-user/get-user-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Get User E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = GetUserUseCase.prototype.execute;
  });

  afterEach(() => {
    GetUserUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to get a user", async () => {
    const response = await request(serverInstance)
      .get("/user/me")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Usuário retornado com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    GetUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/user/me")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    GetUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/user/me")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
