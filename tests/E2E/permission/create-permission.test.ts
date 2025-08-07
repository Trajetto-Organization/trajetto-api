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

import { CreatePermissionUseCase } from "@/modules/permission/usecases/create-permission/create-permission-usecase";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Create Permission E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "user_permission_manage",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = CreatePermissionUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    CreatePermissionUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a permission", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const createPermission = {
      action: "Unique Permission Action",
      businessId: user?.businessId,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    expect(response.statusCode).toEqual(201);
    expect(response.body.message).toBe("Permissão criada com sucesso!");

    const createdPermission = await prisma.permission.findFirst({
      where: {
        action: "Unique Permission Action",
        businessId: user?.businessId as string,
      },
    });

    expect(createdPermission).toBeTruthy();
  });

  it("should throw PermissionBusinessError when trying to create a permission with a profile access from a different business", async () => {
    const newBusinessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Error Test Business",
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
      name: "Profile for Business Error Test",
      businessId: newBusiness.id,
    };

    const profileAccess = await prisma.profileAccess.create({
      data: profileAccessData,
    });

    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true },
    });

    const permissionData = {
      action: "Permission Business Error Test",
      businessId: user?.businessId as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: profileAccess.id,
    };

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(permissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "O perfil de acesso não pertence a essa empresa.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    CreatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Error Test Business",
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

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw PermissionAlreadyAssignedError if permission key is already in use", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const createPermission = {
      action: "Unique Action 2",
      businessId: user?.businessId,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId,
    };

    await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ ...createPermission, action: "New Different Action" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Esta permissão já está atribuída com este perfil.",
    );
  });

  it("should throw PermissionAlreadyExistsError when trying to create a permission with an existing action name for the same profile", async () => {
    const user = await prisma.user.findUnique({
      where: { email: "test@example.com" },
      include: { business: true, profileAccess: true },
    });

    const permissionData = {
      action: "Duplicate Permission Action",
      businessId: user?.businessId as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: user?.profileAccessId as string,
    };

    await prisma.permission.create({
      data: {
        action: permissionData.action,
        businessId: permissionData.businessId,
        canRead: permissionData.canRead,
        canWrite: permissionData.canWrite,
        permissionKey: permissionData.permissionKey,
        profileAccessId: permissionData.profileAccessId,
      },
    });

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(permissionData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
    );
  });

  it("should throw BusinessNotFoundError if business does not found", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Error Test Business",
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
      businessId: "non-business-id",
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    };

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw ProfileAccessNotFoundError if profile access does not found", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Error Test Business",
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

    const createdBusiness = await prisma.business.create({
      data: businessData,
    });

    const createPermission = {
      action: "New Permission Action",
      businessId: createdBusiness.id,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: "non-profile-access-id",
    };

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Perfil de acesso não encontrado! Por favor tente novamente.",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    CreatePermissionUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Error Test Business",
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

    const response = await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
