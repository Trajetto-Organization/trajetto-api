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

import { UpdateBranchUseCase } from "@/modules/branch/usecases/update-branch/update-branch-usecase";
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

describe("Update Branch E2E", () => {
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

    originalExecuteMethod = UpdateBranchUseCase.prototype.execute;
  });

  beforeEach(async () => {
    uniqueBranchName = `Branch ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `branch-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;

    await prisma.branch.deleteMany({
      where: {
        businessId: businessId,
      },
    });
  });

  afterEach(() => {
    UpdateBranchUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to update a branch", async () => {
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
      businessId,
    };

    const createBranch = await prisma.branch.create({
      data: branchData,
    });

    const updateBranchData = {
      corporate_reason: "Branch Updated",
      cnpj: "12345678000100",
      cep: "87654321",
      city: "City Updated",
      uf: "CU",
      street: "Street Updated",
      address_number: "200",
      telephone: "9876543210",
      email: "updated@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Updated",
      erp_code: "ERP100",
    };

    const response = await request(serverInstance)
      .patch(`/branch/update-branch/${createBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBranchData);

    const findBranchById = await prisma.branch.findUnique({
      where: {
        id: createBranch.id,
      },
    });

    expect(response.statusCode).toEqual(200);
    expect(findBranchById).toMatchObject({
      corporate_reason: "Branch Updated",
      city: "City Updated",
      street: "Street Updated",
    });

    expect(response.body.message).toBe("Filial atualizada com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const updateBranchData = {
      corporate_reason: "Valid Branch Name",
    };

    UpdateBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .patch(
        `/branch/update-branch/550e8400-e29b-41d4-a716-446655440000/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBranchData);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw BranchNotFoundError if branch does not exist", async () => {
    const updateBranchData = {
      corporate_reason: "Valid Branch Name",
    };

    const response = await request(serverInstance)
      .patch(
        `/branch/update-branch/550e8400-e29b-41d4-a716-446655440001/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updateBranchData);

    expect(response.statusCode).toEqual(404);
    expect(response.body.message).toBe("Filial não encontrada.");
  });

  it("should throw BranchNameAlreadyExistsError if a branch with the same name exists", async () => {
    const existingBranchData = {
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
      businessId,
    };

    await prisma.branch.create({ data: existingBranchData });

    const targetBranchData = {
      corporate_reason: "Branch02",
      cnpj: "12345678000103",
      cep: "87654321",
      city: "City C",
      uf: "CC",
      street: "Street C",
      address_number: "102",
      telephone: "1111111112",
      email: "branch02@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP104",
      businessId,
    };

    const targetBranch = await prisma.branch.create({
      data: targetBranchData,
    });

    const updatePayload = {
      ...existingBranchData,
      corporate_reason: existingBranchData.corporate_reason,
      cnpj: "98765432000100",
      email: "another@example.com",
      erp_code: "ERP103",
    };

    const response = await request(serverInstance)
      .patch(`/branch/update-branch/${targetBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma filial cadastrada com esta razão social.",
    );
  });

  it("should throw BranchCnpjAlreadyExistsError if a branch with the same CNPJ exists", async () => {
    const existingBranchData = {
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
      businessId,
    };

    await prisma.branch.create({ data: existingBranchData });

    const targetBranchData = {
      corporate_reason: "Branch Two",
      cnpj: "12345678000103",
      cep: "87654321",
      city: "City C",
      uf: "CC",
      street: "Street C",
      address_number: "102",
      telephone: "1111111112",
      email: "branch02@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP104",
      businessId,
    };

    const targetBranch = await prisma.branch.create({
      data: targetBranchData,
    });

    const updatePayload = {
      corporate_reason: "Another Branch",
      cnpj: existingBranchData.cnpj,
      cep: targetBranchData.cep,
      city: targetBranchData.city,
      uf: targetBranchData.uf,
      street: targetBranchData.street,
      address_number: targetBranchData.address_number,
      telephone: targetBranchData.telephone,
      email: "another@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Three",
      erp_code: "ERP103",
    };

    const response = await request(serverInstance)
      .patch(`/branch/update-branch/${targetBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Já existe uma filial com este CNPJ.");
  });

  it("should throw BranchErpCodeAlreadyExistsError if a branch with the same ERP code exists", async () => {
    const existingBranchData = {
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
      businessId,
    };

    await prisma.branch.create({ data: existingBranchData });

    const targetBranchData = {
      corporate_reason: "Branch Two",
      cnpj: "12345678000103",
      cep: "87654321",
      city: "City E",
      uf: "EE",
      street: "Street E",
      address_number: "102",
      telephone: "1111111111",
      email: "branch02@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP002",
      businessId,
    };

    const targetBranch = await prisma.branch.create({
      data: targetBranchData,
    });

    const updatePayload = {
      corporate_reason: "Another Branch",
      cnpj: targetBranchData.cnpj,
      cep: targetBranchData.cep,
      city: targetBranchData.city,
      uf: targetBranchData.uf,
      street: targetBranchData.street,
      address_number: targetBranchData.address_number,
      telephone: targetBranchData.telephone,
      email: "another@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Three",
      erp_code: existingBranchData.erp_code,
    };

    const response = await request(serverInstance)
      .patch(`/branch/update-branch/${targetBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Já existe uma filial com este código ERP.",
    );
  });

  it("should throw BranchEmailAlreadyExistsError if a branch with the same email exists", async () => {
    const existingBranchData = {
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
      businessId,
    };

    await prisma.branch.create({ data: existingBranchData });

    const targetBranchData = {
      corporate_reason: "Branch Two",
      cnpj: "12345678000103",
      cep: "87654321",
      city: "City F",
      uf: "FF",
      street: "Street F",
      address_number: "102",
      telephone: "1111111111",
      email: "branch02@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Two",
      erp_code: "ERP002",
      businessId,
    };

    const targetBranch = await prisma.branch.create({
      data: targetBranchData,
    });

    const updatePayload = {
      corporate_reason: "Another Branch",
      cnpj: targetBranchData.cnpj,
      cep: targetBranchData.cep,
      city: targetBranchData.city,
      uf: targetBranchData.uf,
      street: targetBranchData.street,
      address_number: targetBranchData.address_number,
      telephone: targetBranchData.telephone,
      email: existingBranchData.email,
      cnae: "1111111",
      responsible_name: "Responsible Three",
      erp_code: "ERP003",
    };

    const response = await request(serverInstance)
      .patch(`/branch/update-branch/${targetBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(updatePayload);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Este e-mail já foi cadastrado em uma filial!",
    );
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    const branchData = {
      corporate_reason: "Valid Branch Name",
    };

    UpdateBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .patch(
        `/branch/update-branch/550e8400-e29b-41d4-a716-446655440002/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send(branchData);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
