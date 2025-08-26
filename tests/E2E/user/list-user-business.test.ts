import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ListUserBusinessUseCase } from "@/modules/user/usecases/list-user-business/list-user-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

let userAuthenticated: string;
let businessId: string;

let originalExecuteMethod: any;

describe("List User Business E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: false,
      permissionKey: "user_registration_manage",
    });

    userAuthenticated = authData.token;
    businessId = authData.businessId;

    originalExecuteMethod = ListUserBusinessUseCase.prototype.execute;
  });

  afterEach(() => {
    ListUserBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list users by business correctly", async () => {
    const response = await request(serverInstance)
      .get("/user/list-user-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, businessId });

    const splitResponse = response.text
      .split("\n")
      .filter((line) => line.trim() !== "");

    expect(response.statusCode).toEqual(200);
    expect(splitResponse.length).toBeGreaterThanOrEqual(1);

    const parsedMetaData = JSON.parse(splitResponse[0]);
    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);

    expect(parsedMetaData.meta.page).toBe(1);
    expect(parsedMetaData.meta.pageSize).toBe(10);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListUserBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .get("/user/list-user-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, businessId });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    ListUserBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new BusinessNotFoundError();
      });

    const response = await request(serverInstance)
      .get("/user/list-user-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, businessId });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListUserBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .get("/user/list-user-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, businessId });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
