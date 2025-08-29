import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

import request from "supertest";
import { serverInstance, app } from "@/http";

import { DeleteBranchUseCase } from "@/modules/branch/usecases/delete-branch/delete-branch-usecase";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import prisma from "infra/database";

let userAuthenticated: string;
let businessId: string;

let originalExecuteMethod: any;

describe("Delete Branch E2E", () => {
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
    originalExecuteMethod = DeleteBranchUseCase.prototype.execute;
  });

  afterEach(() => {
    DeleteBranchUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to delete a branch", async () => {
    const branchData = {
      corporate_reason: "Branch to Delete",
      cnpj: "12345678000100",
      cep: "12345678",
      city: "City A",
      uf: "CA",
      street: "Street A",
      address_number: "100",
      telephone: "1234567890",
      email: "delete@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP100",
      businessId,
    };

    const createBranch = await prisma.branch.create({
      data: branchData,
    });

    const response = await request(serverInstance)
      .delete(`/branch/delete-branch/${createBranch.id}/business/${businessId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Filial excluída com sucesso!");
  });

  it("should throw BranchNotFoundError if branch does not found", async () => {
    const response = await request(serverInstance)
      .delete(
        `/branch/delete-branch/550e8400-e29b-41d4-a716-446655440000/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(404);
    expect(response.body.message).toBe("Filial não encontrada.");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    DeleteBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .delete(
        `/branch/delete-branch/550e8400-e29b-41d4-a716-446655440001/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    DeleteBranchUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .delete(
        `/branch/delete-branch/550e8400-e29b-41d4-a716-446655440002/business/${businessId}`,
      )
      .set("Authorization", `Bearer ${userAuthenticated}`);

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
