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

import { CreateBranchUseCase } from "@/modules/branch/usecases/create-branch/create-branch-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

let userAuthenticated: string;
let businessId: string;

let uniqueBranchName: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Create Branch E2E", () => {
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

    originalExecuteMethod = CreateBranchUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueBranchName = `Branch ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);
    uniqueEmail = `branch-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    CreateBranchUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a branch", async () => {
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

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    expect(response.statusCode).toEqual(201);
    expect(response.body.message).toBe("Filial criada com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
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

    CreateBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
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

    CreateBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new BusinessNotFoundError();
    });

    const response = await request(serverInstance)
      .post(`/branch/create-branch/non-business-id`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw BranchNameAlreadyExistsError if branch with same name exists", async () => {
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

    // Create first branch
    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    // Try to create another branch with same name but different fields
    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        ...branchData,
        cnpj: "98765432000100",
        email: "another@example.com",
        erp_code: "ERP999",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma filial cadastrada com esta razão social.",
    );
  });

  it("should throw BranchCnpjAlreadyExistsError if branch with same cnpj exists", async () => {
    const branchData1 = {
      corporate_reason: "Branch One",
      cnpj: "12345678000103",
      cep: "12345678",
      city: "City D",
      uf: "CD",
      street: "Street D",
      address_number: "103",
      telephone: "1111111113",
      email: "branch1@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP104",
    };

    const branchData2 = {
      corporate_reason: "Branch Two",
      cnpj: "12345678000103", // same CNPJ
      cep: "87654321",
      city: "City E",
      uf: "CE",
      street: "Street E",
      address_number: "104",
      telephone: "2222222222",
      email: "branch2@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP105",
    };

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData1);

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Já existe uma filial com este CNPJ.");
  });

  it("should throw BranchErpCodeAlreadyExistsError if branch with same erp code exists", async () => {
    const branchData1 = {
      corporate_reason: "Erp Branch",
      cnpj: "12345678000105",
      cep: "12345678",
      city: "City F",
      uf: "CF",
      street: "Street F",
      address_number: "105",
      telephone: "1111111114",
      email: "erp@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP106",
    };

    const branchData2 = {
      corporate_reason: "Different Branch",
      cnpj: "12345678000106",
      cep: "87654321",
      city: "City G",
      uf: "CG",
      street: "Street G",
      address_number: "106",
      telephone: "2222222223",
      email: "differenterp@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP106", // same ERP code
    };

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData1);

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma filial com este código ERP.",
    );
  });

  it("should throw BranchEmailAlreadyExistsError if branch with same email exists", async () => {
    const branchData1 = {
      corporate_reason: "Email Branch",
      cnpj: "12345678000107",
      cep: "12345678",
      city: "City H",
      uf: "CH",
      street: "Street H",
      address_number: "107",
      telephone: "1111111115",
      email: "duplicate@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP107",
    };

    const branchData2 = {
      corporate_reason: "Different Branch",
      cnpj: "12345678000108",
      cep: "87654321",
      city: "City I",
      uf: "CI",
      street: "Street I",
      address_number: "108",
      telephone: "2222222224",
      email: "duplicate@example.com", // same email
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP108",
    };

    await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData1);

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData2);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este e-mail já foi cadastrado em uma filial!",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
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

    CreateBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .post(`/branch/create-branch/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
