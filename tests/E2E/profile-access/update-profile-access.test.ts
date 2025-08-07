import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { createAuthenticateUser } from "utils/tests/create-authenticate-user";
import { UpdateProfileAccessUseCase } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;
let profileAccessId: string;

let businessId: string;
let originalExecuteMethod: any;

describe("Update Profile Access E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "profile_access_manage",
    });

    userAuthenticated = authData.token;
    profileAccessId = authData.profileAccessId;

    businessId = authData.businessId;
    originalExecuteMethod = UpdateProfileAccessUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateProfileAccessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update a profile access", async () => {
    const newProfileAccess = await prisma.profileAccess.create({
      data: {
        name: "Analyst",
        businessId: businessId,
      },
    });

    const updatePayload = {
      name: "Senior Analyst",
      businessId: businessId,
    };

    const response = await request(serverInstance)
      .patch(`/profile-access/update-profile-access/${newProfileAccess.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Perfil de acesso atualizado com sucesso!",
    );

    const updatedProfileAccess = await prisma.profileAccess.findUnique({
      where: { id: newProfileAccess.id },
    });

    expect(updatedProfileAccess?.name).toBe("Senior Analyst");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const updateProfileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .patch("/profile-access/update-profile-access/non-profile-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw ProfileAccessCannotBeUpdatedByHimselfError if the user tries to update their own profile access", async () => {
    const updateProfileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .patch(`/profile-access/update-profile-access/${profileAccessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccess);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para atualizar o seu próprio perfil de acesso.",
    );
  });

  it("should throw BusinessNotFoundError if business does not found", async () => {
    const businessData = {
      corporate_reason: "Update Business",
      cnpj: "12345678912345",
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "updatebusiness@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP200",
    };

    const createdBusiness = await prisma.business.create({
      data: businessData,
    });

    const createdProfileAccess = await prisma.profileAccess.create({
      data: {
        name: "Management",
        businessId: createdBusiness.id,
      },
    });

    const updateProfileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .patch(`/profile-access/update-profile-access/${createdProfileAccess.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw ProfileAccessNotFoundError if profile access does not found", async () => {
    const updateProfileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .patch("/profile-access/update-profile-access/non-profile-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccess);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Perfil de acesso não encontrado!");
  });

  it("should throw ProfileAccessAlreadyExistsError if profile access already exists", async () => {
    const anotherProfileAccess = await prisma.profileAccess.create({
      data: {
        name: "Analyst",
        businessId: businessId,
      },
    });

    const updateProfileAccessPayload = {
      name: "Management",
      businessId: businessId,
    };

    const response = await request(serverInstance)
      .patch(`/profile-access/update-profile-access/${anotherProfileAccess.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccessPayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este perfil de acesso já existe para esta empresa!",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const updateProfileAccess = {
      name: "Test Name",
      businessId: "non-business-id",
    };

    const response = await request(serverInstance)
      .patch("/profile-access/update-profile-access/non-profile-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateProfileAccess);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
