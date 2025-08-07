import {
  beforeAll,
  describe,
  expect,
  it,
  vi,
  afterEach,
  beforeEach,
} from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { createAuthenticateUser } from "utils/tests/create-authenticate-user";
import { ListProfileAccessUseCase } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("List Profile Access E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListProfileAccessUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    ListProfileAccessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list profile access correctly", async () => {
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

    const profileAccessData = {
      name: "New Profile Access",
      businessId: createdBusiness.id,
    };

    await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccessData);

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");
    const parsedProfileAccessValues = JSON.parse(splitResponse[1]);

    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedProfileAccessValues.name).toBe("New Profile Access");

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list profile access matching search query", async () => {
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

    const profileAccessData = {
      name: "Unique Search Name",
      businessId: createdBusiness.id,
    };

    await request(serverInstance)
      .post("/profile-access/create-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(profileAccessData);

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-access")
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
    ListProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListProfileAccessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-access")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
