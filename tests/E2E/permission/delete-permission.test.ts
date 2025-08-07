import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { container } from "tsyringe";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { createAuthenticateUser } from "utils/tests/create-authenticate-user";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { DeletePermissionUseCase } from "@/modules/permission/usecases/delete-permission/delete-permission-usecase";
import prisma from "infra/database";

let userAuthenticated: string;
let permissionId: string;

let originalExecuteMethod: any;

describe("Delete Permission E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "user_permission_manage",
    });

    userAuthenticated = authData.token;
    permissionId = authData.permissionId;

    originalExecuteMethod = DeletePermissionUseCase.prototype.execute;
  });

  beforeEach(() => {
    container.clearInstances();
  });

  afterEach(() => {
    DeletePermissionUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a permission", async () => {
    const businessData = {
      corporate_reason: "New Business Permission",
      cnpj: "11111111111111",
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "newpermission@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP111",
    };

    const createdBusiness = await prisma.business.create({
      data: businessData,
    });

    const profileAccess = {
      name: "Test Permission Name",
      businessId: createdBusiness.id,
    };

    const createdProfileAccess = await prisma.profileAccess.create({
      data: profileAccess,
    });

    const createPermission = {
      action: "New Permission Action",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    };

    const createdPermission = await prisma.permission.create({
      data: createPermission,
    });

    const response = await request(serverInstance)
      .delete(`/permission/delete-permission/${createdPermission.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Permissão deletada com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeletePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .delete("/permission/delete-permission/non-permission-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw PermissionCannotBeDeletedByHimselfError if the user tries to delete their own permission", async () => {
    const response = await request(serverInstance)
      .delete(`/permission/delete-permission/${permissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para deletar a sua própria permissão",
    );
  });

  it("should throw PermissionNotFoundError if pernmission does not found", async () => {
    const response = await request(serverInstance)
      .delete("/permission/delete-permission/non-permission-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Permissão não encontrada!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeletePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .delete("/permission/delete-permission/non-permission-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
