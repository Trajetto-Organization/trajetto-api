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

import { UpdateBusinessUseCase } from "@/modules/business/usecases/update-business/update-business-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Update Business E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = UpdateBusinessUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;

    await prisma.business.deleteMany({});
  });

  afterEach(() => {
    UpdateBusinessUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update a business", async () => {
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

    const createBusiness = await prisma.business.create({
      data: businessData,
    });

    const updateBusinessData = {
      corporate_reason: "Business Updated",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia Update",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street Updated",
      address_number: "100",
      telephone: "1234567890",
      email: "newbusiness@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP100",
    };

    const response = await request(serverInstance)
      .patch(`/business/update-business/${createBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBusinessData);

    const findBusinessById = await prisma.business.findUnique({
      where: {
        id: createBusiness.id,
      },
    });

    expect(response.statusCode).toEqual(200);
    expect(findBusinessById).toMatchObject({
      corporate_reason: "Business Updated",
      fantasy_name: "Fantasia Update",
      street: "Street Updated",
    });

    expect(response.body.message).toBe("Empresa atualizada com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const updateBusinessData = {
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

    UpdateBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .patch("/business/update-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBusinessData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const updateBusinessData = {
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
      .patch("/business/update-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBusinessData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw CnpjAlreadyExistsError if a business with the same CNPJ exists", async () => {
    const existingBusinessData = {
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

    await prisma.business.create({ data: existingBusinessData });

    const targetBusinessData = {
      corporate_reason: "Business02",
      cnpj: "12345678000103",
      fantasy_name: "Fantasia 02",
      cep: "12345678",
      city: "City C",
      uf: "CC",
      street: "Street C",
      address_number: "102",
      telephone: "1111111112",
      email: "test02@example.com",
      cnae: "3333333",
      responsible_name: "Responsible Unique",
      erp_code: "ERP104",
    };

    const targetBusiness = await prisma.business.create({
      data: targetBusinessData,
    });

    const updatePayload = {
      ...existingBusinessData,
      corporate_reason: "Another Business",
      fantasy_name: "Another Fantasia",
      email: "another@example.com",
      erp_code: "ERP103",
    };

    const response = await request(serverInstance)
      .patch(`/business/update-business/${targetBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este cnpj já foi cadastrado em uma empresa!",
    );
  });

  it("should throw CorporateReasonAlreadyExistsError if a business with the same corporate reason exists", async () => {
    const existingBusinessData = {
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

    await prisma.business.create({ data: existingBusinessData });

    const targetBusinessData = {
      corporate_reason: "Different Corporate Reason",
      cnpj: "12345678000103",
      fantasy_name: "Fantasia 02",
      cep: "12345678",
      city: "City C",
      uf: "CC",
      street: "Street C",
      address_number: "102",
      telephone: "1111111112",
      email: "test02@example.com",
      cnae: "3333333",
      responsible_name: "Responsible Unique",
      erp_code: "ERP104",
    };

    const targetBusiness = await prisma.business.create({
      data: targetBusinessData,
    });

    const updatePayload = {
      ...targetBusinessData,
      corporate_reason: existingBusinessData.corporate_reason,
      fantasy_name: "Updated Fantasia",
      email: "updated@example.com",
      erp_code: "ERP103",
    };

    const response = await request(serverInstance)
      .patch(`/business/update-business/${targetBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Esta razão social já foi cadastrada em uma empresa!",
    );
  });

  it("should throw ErpCodeAlreadyExistsError if a business with the same ERP code exists", async () => {
    const existingBusinessData = {
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

    await prisma.business.create({ data: existingBusinessData });

    const targetBusinessData = {
      corporate_reason: "Business Two",
      cnpj: "12345678000103",
      fantasy_name: "Fantasia Two",
      cep: "12345678",
      city: "City E",
      uf: "EE",
      street: "Street E",
      address_number: "102",
      telephone: "1111111111",
      email: "test02@example.com",
      cnae: "3333333",
      responsible_name: "Responsible Unique",
      erp_code: "ERP002",
    };

    const targetBusiness = await prisma.business.create({
      data: targetBusinessData,
    });

    const updatePayload = {
      corporate_reason: "Another Business",
      cnpj: targetBusinessData.cnpj,
      fantasy_name: "Another Fantasia",
      cep: targetBusinessData.cep,
      city: targetBusinessData.city,
      uf: targetBusinessData.uf,
      street: targetBusinessData.street,
      address_number: targetBusinessData.address_number,
      telephone: targetBusinessData.telephone,
      email: "another@example.com",
      cnae: targetBusinessData.cnae,
      responsible_name: targetBusinessData.responsible_name,
      erp_code: existingBusinessData.erp_code,
    };

    const response = await request(serverInstance)
      .patch(`/business/update-business/${targetBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este código erp já foi cadastrado em uma empresa!",
    );
  });

  it("should throw EmailAlreadyExistsError if a business with the same email exists", async () => {
    const existingBusinessData = {
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

    await prisma.business.create({ data: existingBusinessData });

    const targetBusinessData = {
      corporate_reason: "Business Two",
      cnpj: "12345678000103",
      fantasy_name: "Fantasia Two",
      cep: "12345678",
      city: "City F",
      uf: "FF",
      street: "Street F",
      address_number: "102",
      telephone: "1111111111",
      email: "test02@example.com",
      cnae: "3333333",
      responsible_name: "Responsible Unique",
      erp_code: "ERP002",
    };

    const targetBusiness = await prisma.business.create({
      data: targetBusinessData,
    });

    const updatePayload = {
      corporate_reason: "Another Business",
      cnpj: targetBusinessData.cnpj,
      fantasy_name: "Another Fantasia",
      cep: targetBusinessData.cep,
      city: targetBusinessData.city,
      uf: targetBusinessData.uf,
      street: targetBusinessData.street,
      address_number: targetBusinessData.address_number,
      telephone: targetBusinessData.telephone,
      email: existingBusinessData.email,
      cnae: targetBusinessData.cnae,
      responsible_name: targetBusinessData.responsible_name,
      erp_code: "ERP003",
    };

    const response = await request(serverInstance)
      .patch(`/business/update-business/${targetBusiness.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

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

    UpdateBusinessUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .patch("/business/update-business/non-business-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(businessData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
