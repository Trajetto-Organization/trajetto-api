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
import { ListPermissionUseCase } from "@/modules/permission/usecases/list-permission/list-permission-usecase";

import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("List Permissions E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListPermissionUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;

    container.clearInstances();
  });

  afterEach(() => {
    ListPermissionUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list permissions correctly", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: uniqueEmail,
      cnae: "1111111",
      responsible_name: "Responsible One",
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

    await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    const response = await request(serverInstance)
      .get("/permission/list-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");

    const parsedPermissionValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedPermissionValues.action).toBe("New Permission Action");

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list permissions matching search query", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: uniqueEmail,
      cnae: "1111111",
      responsible_name: "Responsible One",
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
      action: "Unique Permission",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    };

    await request(serverInstance)
      .post("/permission/create-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(createPermission);

    const response = await request(serverInstance)
      .get("/permission/list-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, search: "Unique" });

    const splitResponse = response.text
      .split("\n")
      .filter((line) => line.trim() !== "");

    const parsedMetaData = JSON.parse(splitResponse[0]);
    const parsedUser = JSON.parse(splitResponse[1]);

    expect(response.statusCode).toEqual(200);
    expect(parsedUser.action).toBe("Unique Permission");

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListPermissionUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/permission/list-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListPermissionUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/permission/list-permission")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
