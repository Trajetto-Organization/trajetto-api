import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterEach,
  beforeEach,
} from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { ListBusinessUseCase } from "@/modules/business/usecases/list-business/list-business-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("List Business E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListBusinessUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    ListBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list businesses correctly", async () => {
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

    await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    const response = await request(serverInstance)
      .get("/business/list-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10 });

    const splitResponse = response.text.split("\n");

    const parsedBusinessValues = JSON.parse(splitResponse[1]);
    const parsedMetaData = JSON.parse(splitResponse[0]);

    expect(response.statusCode).toEqual(200);
    expect(parsedBusinessValues.corporate_reason).toBe(uniqueCorporateReason);

    const { meta } = parsedMetaData;

    expect(meta.total).toBe(1);
    expect(meta.page).toBe(1);

    expect(meta.pageSize).toBe(10);
  });

  it("should list business matching search query", async () => {
    const businessData = {
      corporate_reason: uniqueCorporateReason,
      cnpj: uniqueCNPJ,
      fantasy_name: "Unique New Fantasia",
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
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    const response = await request(serverInstance)
      .get("/business/list-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, search: "Unique" });

    const splitResponse = response.text
      .split("\n")
      .filter((line) => line.trim() !== "");

    const parsedMetaData = JSON.parse(splitResponse[0]);
    const parsedUser = JSON.parse(splitResponse[1]);

    expect(response.statusCode).toEqual(200);
    expect(parsedUser.fantasy_name).toBe("Unique New Fantasia");

    expect(parsedMetaData.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .get("/business/list-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .get("/business/list-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2 });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
