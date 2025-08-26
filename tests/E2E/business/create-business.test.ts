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

import { CreateBusinessUseCase } from "@/modules/business/usecases/create-business/create-business-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Create Business E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });
    userAuthenticated = authData.token;
    originalExecuteMethod = CreateBusinessUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    CreateBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a business", async () => {
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

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    expect(response.statusCode).toEqual(201);
    expect(response.body.message).toBe(
      "Empresa e filial matriz criadas com sucesso!",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
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

    CreateBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw CnpjAlreadyExistsError if business with same cnpj exists", async () => {
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

    // Create your first business
    await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    // Try to create another business with the same CNPJ, but with different fields
    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        ...businessData,
        corporate_reason: "Another Business",
        fantasy_name: "Another Fantasia",
        email: "another@example.com",
        erp_code: "ERP103",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este cnpj já foi cadastrado em uma empresa!",
    );
  });

  it("should throw CorporateReasonAlreadyExistsError if business with same corporate reason exists", async () => {
    const businessData1 = {
      corporate_reason: "Unique Corporate",
      cnpj: "12345678000103",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City D",
      uf: "CD",
      street: "Street D",
      address_number: "103",
      telephone: "1111111113",
      email: "unique2@example.com",
      cnae: "4444444",
      responsible_name: "Responsible One",
      erp_code: "ERP104",
    };

    const businessData2 = {
      corporate_reason: "Unique Corporate", // same corporate_reason
      cnpj: "12345678000104", // Different CNPJ
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City E",
      uf: "CE",
      street: "Street E",
      address_number: "104",
      telephone: "2222222222",
      email: "different@example.com",
      cnae: "5555555",
      responsible_name: "Responsible Two",
      erp_code: "ERP105",
    };

    await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData1);

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Esta razão social já foi cadastrada em uma empresa!",
    );
  });

  it("should throw ErpCodeAlreadyExistsError if business with same erp code exists", async () => {
    const businessData1 = {
      corporate_reason: "Erp Business",
      cnpj: "12345678000105",
      fantasy_name: "Erp Fantasia",
      cep: "12345678",
      city: "City F",
      uf: "CF",
      street: "Street F",
      address_number: "105",
      telephone: "1111111114",
      email: "erp@example.com",
      cnae: "6666666",
      responsible_name: "Responsible Erp",
      erp_code: "ERP106",
    };

    const businessData2 = {
      corporate_reason: "Different Corporate",
      cnpj: "12345678000106",
      fantasy_name: "Different Fantasia",
      cep: "87654321",
      city: "City G",
      uf: "CG",
      street: "Street G",
      address_number: "106",
      telephone: "2222222223",
      email: "differenterp@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Different",
      erp_code: "ERP106", // same ERP code
    };

    await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData1);

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este código erp já foi cadastrado em uma empresa!",
    );
  });

  it("should throw EmailAlreadyExistsError if business with same email exists", async () => {
    const businessData1 = {
      corporate_reason: "Email Business",
      cnpj: "12345678000107",
      fantasy_name: "Email Fantasia",
      cep: "12345678",
      city: "City H",
      uf: "CH",
      street: "Street H",
      address_number: "107",
      telephone: "1111111115",
      email: "duplicate@example.com",
      cnae: "8888888",
      responsible_name: "Responsible Email",
      erp_code: "ERP107",
    };

    const businessData2 = {
      corporate_reason: "Different Corporate",
      cnpj: "12345678000108",
      fantasy_name: "Different Fantasia",
      cep: "87654321",
      city: "City I",
      uf: "CI",
      street: "Street I",
      address_number: "108",
      telephone: "2222222224",
      email: "duplicate@example.com", // same email
      cnae: "9999999",
      responsible_name: "Responsible Different",
      erp_code: "ERP108",
    };

    await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData1);

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este e-mail já foi cadastrado em uma empresa!",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
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

    CreateBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .post("/business/create-business")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
