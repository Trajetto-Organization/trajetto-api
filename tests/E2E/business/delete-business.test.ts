import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { DeleteBusinessUseCase } from "@/modules/business/usecases/delete-business/delete-business-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Delete Business E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = DeleteBusinessUseCase.prototype.execute;
  });

  afterEach(() => {
    DeleteBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a business", async () => {
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

    const createBusiness = await prisma.business.create({
      data: businessData,
    });

    const response = await request(serverInstance)
      .delete(`/business/delete-business/${createBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Empresa deletada com sucesso!");
  });

  it("should throw BusinessNotFoundError if business does not found", async () => {
    const response = await request(serverInstance)
      .delete("/business/delete-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeleteBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .delete("/business/delete-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeleteBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .delete("/business/delete-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
