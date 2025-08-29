import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { ListBranchUseCase } from "@/modules/branch/usecases/list-branch/list-branch-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;
let businessId: string;

let uniqueBranchName: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("List Branch E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
      canWrite: true,
      permissionKey: "branch_manage",
    });

    userAuthenticated = authData.token;

    businessId = authData.businessId;
    originalExecuteMethod = ListBranchUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueBranchName = `Branch ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `branch-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;

    // Limpar branches antes de cada teste
    await prisma.branch.deleteMany({
      where: {
        businessId: businessId,
      },
    });
  });

  afterEach(() => {
    ListBranchUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list branches correctly", async () => {
    const branchData = {
      corporate_reason: uniqueBranchName,
      cnpj: uniqueCNPJ,
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

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    const response = await request(serverInstance)
      .get("/branch/list-branch")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");

    const parsedBranchValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedBranchValues.corporate_reason).toBe(uniqueBranchName);

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list branch matching search query", async () => {
    const branchData = {
      corporate_reason: "Unique Branch Name",
      cnpj: uniqueCNPJ,
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

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    const response = await request(serverInstance)
      .get("/branch/list-branch")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, search: "Unique" });

    const splitResponse = response.text.split("\n");

    const parsedBranch = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedBranch.corporate_reason).toBe("Unique Branch Name");

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should list branches by business correctly", async () => {
    const branchData = {
      corporate_reason: uniqueBranchName,
      cnpj: uniqueCNPJ,
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

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    const response = await request(serverInstance)
      .get("/branch/list-branch-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({
        page: 1,
        pageSize: 10,
        businessId: businessId,
      });

    const splitResponse = response.text.split("\n");

    const parsedBranchValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);

    expect(parsedBranchValues.corporate_reason).toBe(uniqueBranchName);
    expect(parsedBranchValues.businessId).toBe(businessId);

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list branches by business matching search query", async () => {
    const branchData = {
      corporate_reason: "Unique Business Branch",
      cnpj: uniqueCNPJ,
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

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    const response = await request(serverInstance)
      .get("/branch/list-branch-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({
        page: 1,
        pageSize: 10,
        businessId: businessId,
        search: "Business",
      });

    const splitResponse = response.text.split("\n");

    const parsedBranch = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);

    expect(parsedBranch.corporate_reason).toBe("Unique Business Branch");
    expect(parsedBranch.businessId).toBe(businessId);

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/branch/list-branch")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/branch/list-branch")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
