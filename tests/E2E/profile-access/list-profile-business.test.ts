import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { createAuthenticateUser } from "utils/tests/create-authenticate-user";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListProfileBusinessUseCase } from "@/modules/profile-access/usecases/list-profile-business/list-profile-business-usecase";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import prisma from "infra/database";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("List Profile Access E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = ListProfileBusinessUseCase.prototype.execute;
  });

  afterEach(() => {
    ListProfileBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should list profile business correctly", async () => {
    const businessData = {
      corporate_reason: "New Business",
      cnpj: "12345678000100",
      fantasy_name: "New Fantasia",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "newbusiness@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP100",
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
      .get("/profile-access/list-profile-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 10, businessId: createdBusiness.id });

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

  it("should throw BusinessNotFoundError if business does not found", async () => {
    ListProfileBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new BusinessNotFoundError();
      });

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2, businessId: "non-business-id" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    ListProfileBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2, businessId: "non-business-id" });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    ListProfileBusinessUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(() => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .get("/profile-access/list-profile-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .query({ page: 1, pageSize: 2, businessId: "non-business-id" });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
