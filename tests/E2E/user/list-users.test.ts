import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ListUsersUseCase } from "@/modules/user/usecases/list-users/list-users-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import prisma from "infra/database";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("List Users E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListUsersUseCase.prototype.execute;
  });

  afterEach(() => {
    ListUsersUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list users correctly", async () => {
    await prisma.user.create({
      data: {
        email: "another@example.com",
        name: "Another User",
        password: "dummy",
        role: "BUSINESS_USER",
      },
    });

    const response = await request(serverInstance)
      .get("/user/list-users")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");

    const parsedProfileAccessValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedProfileAccessValues.name).toBe("Another User");

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list users matching search query", async () => {
    await prisma.user.create({
      data: {
        email: "unique@example.com",
        name: "Unique Search Name",
        password: "dummy",
        role: "BUSINESS_USER",
      },
    });

    const response = await request(serverInstance)
      .get("/user/list-users")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, search: "Unique" });

    const splitResponse = response.text
      .split("\n")
      .filter((line) => line.trim() !== "");

    const parsedMetaData = JSON.parse(splitResponse[0]);
    const parsedUser = JSON.parse(splitResponse[1]);

    expect(response.statusCode).toEqual(200);
    expect(parsedUser.name).toBe("Unique Search Name");

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListUsersUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/user/list-users")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListUsersUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/user/list-users")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  }, 15000);
});
