import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { CreateProfileAccessUseCase } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-usecase";

let userAuthenticated: string;
let businessId: string;

let originalExecuteMethod: any;

describe("Create Profile Access E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "profile_access_manage",
    });

    userAuthenticated = authData.token;
    businessId = authData.businessId;

    originalExecuteMethod = CreateProfileAccessUseCase.prototype.execute;
  });

  afterEach(() => {
    CreateProfileAccessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a profile access", async () => {
    const profileAccess = {
      name: "Test Name",
      businessId: businessId,
    };

    const response = await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccess);

    expect(response.statusCode).toEqual(201);
    expect(response.body.message).toBe("Perfil de acesso criado com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    CreateProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const profileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw ProfileAccessAlreadyExistsError if profile access already exists", async () => {
    const profileAccess = {
      name: "Management",
      businessId: businessId,
    };

    const response = await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
    );
  });

  it("should throw BusinessNotFoundError if business does not found", async () => {
    const profileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    CreateProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const profileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccess);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
