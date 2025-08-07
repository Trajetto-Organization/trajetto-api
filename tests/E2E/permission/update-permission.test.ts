import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import request from "supertest";
import { app, serverInstance } from "@/http";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { PermissionNotFoundError } from "@/modules/permission/usecases/errors/permission-not-found-error";

import { PermissionCannotBeUpdatedByHimselfError } from "@/modules/permission/usecases/errors/permission-cannot-be-updated-by-himself-error";
import { PermissionAlreadyExistsError } from "@/modules/permission/usecases/errors/permission-already-exists-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { UpdatePermissionUseCase } from "@/modules/permission/usecases/update-permission/update-permission-usecase";

import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let permissionId: string;
let originalExecuteMethod: any;

describe("Update Permission E2E", () => {
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

    originalExecuteMethod = UpdatePermissionUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    UpdatePermissionUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update a permission", async () => {
    const newBusinessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Update Test Business",
      cep: "12345678",
      city: "City B",
      uf: "CB",
      street: "Street B",
      address_number: "200",
      telephone: "0987654321",
      email: uniqueEmail,
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: uniqueERPCode,
    };

    const newBusiness = await prisma.business.create({
      data: newBusinessData,
    });

    const profileAccessData = {
      name: "Profile Test",
      businessId: newBusiness.id,
    };

    const profileAccess = await prisma.profileAccess.create({
      data: profileAccessData,
    });

    const createPermission = {
      action: "Unique Permission Action",
      businessId: newBusiness.id,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const createdPermission = await prisma.permission.create({
      data: createPermission,
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: newBusiness.id,
      canRead: true,
      canWrite: false,
      permissionKey: "user_registration_manage",
      profileAccessId: profileAccess.id,
    };

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${createdPermission.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Permissão atualizada com sucesso!");

    const updatedPermission = await prisma.permission.findUnique({
      where: { id: createdPermission.id },
    });

    expect(updatedPermission?.action).toBe(updatePermissionData.action);
    expect(updatedPermission?.canWrite).toBe(updatePermissionData.canWrite);
  });

  it("should throw ResourceNotFoundError when user doesn't exist", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: user?.businessId,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${permissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw PermissionCannotBeUpdatedByHimselfError when user tries to update their own permission", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: user?.businessId,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new PermissionCannotBeUpdatedByHimselfError();
      });

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${permissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para atualizar a sua própria permissão",
    );
  });

  it("should throw PermissionBusinessError when profile access doesn't belong to the business", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Update Test Business",
      cep: "12345678",
      city: "City B",
      uf: "CB",
      street: "Street B",
      address_number: "200",
      telephone: "0987654321",
      email: uniqueEmail,
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: uniqueERPCode,
    };

    const business = await prisma.business.create({
      data: businessData,
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        name: `Profile Test ${Date.now()}`,
        businessId: business.id,
      },
    });

    const createPermission = {
      action: "Unique Permission Action",
      businessId: business.id,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const createdPermission = await prisma.permission.create({
      data: createPermission,
    });

    const newBusinessData = {
      corporate_reason: "Updated New Business",
      cnpj: "9876543210987654",
      fantasy_name: "Update Test Business",
      cep: "12345678",
      city: "City B",
      uf: "CB",
      street: "Street B",
      address_number: "200",
      telephone: "0987654321",
      email: "updatednewbusiness@example.com",
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: "UPDATEDERP453",
    };

    const newBusiness = await prisma.business.create({
      data: newBusinessData,
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: newBusiness.id,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${createdPermission.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "O perfil de acesso não pertence a essa empresa.",
    );
  });

  it("should throw PermissionAlreadyExistsError when permission action already exists for that profile", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: user?.businessId,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new PermissionAlreadyExistsError();
      });

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${permissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
    );
  });

  it("should throw PermissionNotFoundError when permission doesn't exist", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const nonExistentPermissionId = "non-existent-id";

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: user?.businessId,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new PermissionNotFoundError();
      });

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${nonExistentPermissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Permissão não encontrada!");
  });

  it("should throw ProfileAccessNotFoundError when profile access doesn't exist", async () => {
    const newBusinessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Update Test Business",
      cep: "12345678",
      city: "City B",
      uf: "CB",
      street: "Street B",
      address_number: "200",
      telephone: "0987654321",
      email: uniqueEmail,
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: uniqueERPCode,
    };

    const newBusiness = await prisma.business.create({
      data: newBusinessData,
    });

    const profileAccessData = {
      name: "Profile Test",
      businessId: newBusiness.id,
    };

    const profileAccess = await prisma.profileAccess.create({
      data: profileAccessData,
    });

    const createPermission = {
      action: "Unique Permission Action",
      businessId: newBusiness.id,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const createdPermission = await prisma.permission.create({
      data: createPermission,
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: newBusiness.id,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: "non-existent-profile-access-id",
    };

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${createdPermission.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Perfil de acesso não encontrado!");
  });

  it("should throw BusinessNotFoundError when business doesn't exist", async () => {
    const newBusinessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Update Test Business",
      cep: "12345678",
      city: "City B",
      uf: "CB",
      street: "Street B",
      address_number: "200",
      telephone: "0987654321",
      email: uniqueEmail,
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: uniqueERPCode,
    };

    const newBusiness = await prisma.business.create({
      data: newBusinessData,
    });

    const profileAccess = await prisma.profileAccess.create({
      data: { name: "Profile Test", businessId: newBusiness.id },
    });

    const createPermission = {
      action: "Unique Permission Action",
      businessId: newBusiness.id,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const createdPermission = await prisma.permission.create({
      data: createPermission,
    });

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new BusinessNotFoundError();
      });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: newBusiness.id,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${createdPermission.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const updatePermissionData = {
      action: `Updated Action ${Date.now()}`,
      businessId: user?.businessId,
      canRead: true,
      canWrite: false,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    UpdatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch(`/permission/update-permission/${permissionId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePermissionData);

    expect(response.statusCode).toEqual(500);
  });
});
