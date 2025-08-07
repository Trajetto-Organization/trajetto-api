import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DeleteProfileAccessUseCase } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-usecase";

import prisma from "infra/database";

let userAuthenticated: string;
let profileAccessId: string;

let originalExecuteMethod: any;

describe("Delete Profile Access E2E", () => {
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

    originalExecuteMethod = DeleteProfileAccessUseCase.prototype.execute;
  });

  afterEach(() => {
    DeleteProfileAccessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a profile access", async () => {
    const businessData = {
      corporate_reason: "Delete Business",
      cnpj: "12345678912345",
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "deletebusiness@example.com",
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

    const response = await request(serverInstance)
      .delete(
        `/profile-access/delete-profile-access/${createdProfileAccess.id}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Perfil de acesso deletado com sucesso!",
    );
  });

  it("should throw ProfileAccessNotFoundError if profile access does not found", async () => {
    const response = await request(serverInstance)
      .delete("/profile-access/delete-profile-access/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Perfil de acesso não encontrado!");
  });

  it("should throw ProfileAccessCannotBeDeletedByHimselfError if the user tries to delete their own profile access", async () => {
    const response = await request(serverInstance)
      .delete(`/profile-access/delete-profile-access/${profileAccessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para deletar o seu próprio perfil de acesso.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeleteProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .delete("/profile-access/delete-profile-access/non-profile-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeleteProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .delete("/profile-access/delete-profile-access/non-profile-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
