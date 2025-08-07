import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterEach,
  beforeEach,
} from "vitest";

import { hash } from "bcrypt";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UpdateUserUseCase } from "@/modules/user/usecases/update-user/update-user-usecase";
import prisma from "infra/database";

let userAuthenticated: string;
let userId: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Update User E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    userId = authData.userId;

    originalExecuteMethod = UpdateUserUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    UpdateUserUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should update user successfully", async () => {
    const business = await prisma.business.create({
      data: {
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
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const createdUser = await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${createdUser.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        name: "Updated Name",
        email: `updated-${uniqueEmail}`,
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe("Usuário atualizado com sucesso!");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const business = await prisma.business.create({
      data: {
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
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const user = await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New User",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${user.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        businessId: "non-exist-business-id",
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw UserCannotBeUpdatedByHimselfError if admin tries to update itself", async () => {
    const response = await request(serverInstance)
      .patch(`/user/update-user/${userId}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        businessId: "non-exist-business-id",
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "Usuário não tem permissão para atualizar o seu próprio usuário.",
    );
  });

  it("should throw UserProfileNotMatchBusinessError if profile access business does not match", async () => {
    const business = await prisma.business.create({
      data: {
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
      },
    });

    const newBusiness = await prisma.business.create({
      data: {
        corporate_reason: `${uniqueCorporateReason}-2`,
        cnpj: `${uniqueCNPJ}2`,
        fantasy_name: "New Fantasia 2",
        cep: "12345678",
        city: "City B",
        uf: "CB",
        street: "Street B",
        address_number: "200",
        telephone: "0987654321",
        email: `second-${uniqueEmail}`,
        cnae: "2222222",
        responsible_name: "Responsible Two",
        erp_code: `${uniqueERPCode}-2`,
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const user = await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New User",
        role: "BUSINESS_USER",
        businessId: newBusiness.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${user.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        name: "Updated Name",
        email: `updated-${uniqueEmail}`,
        role: "BUSINESS_USER",
        businessId: newBusiness.id,
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "O perfil de acesso informado não pertence à mesma empresa do usuário.",
    );
  });

  it("should throw BusinessNotFoundError if business is not found", async () => {
    const business = await prisma.business.create({
      data: {
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
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const user = await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New User",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${user.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        businessId: "non-exist-business-id",
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Empresa não encontrada! Por favor, tente novamente.",
    );
  });

  it("should throw ProfileAccessNotFoundError if profile access is not found", async () => {
    const business = await prisma.business.create({
      data: {
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
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const user = await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New User",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${user.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: "gabriel@example.com",
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe(
      "Perfil de acesso não encontrado! Por favor tente novamente.",
    );
  });

  it("should return 409 if trying to update user with an existing email", async () => {
    const business = await prisma.business.create({
      data: {
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
      },
    });

    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    await prisma.user.create({
      data: {
        password: await hash("1234567", 6),
        email: "existing@example.com",
        name: "Existing User",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const user = await prisma.user.create({
      data: {
        password: await hash("password456", 6),
        email: "new@example.com",
        name: "New User",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      },
    });

    const response = await request(serverInstance)
      .patch(`/user/update-user/${user.id}`)
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        name: "Updated Name",
        email: "existing@example.com",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(409);
    expect(response.body.message).toBe("Este usuário já foi cadastrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .patch("/user/update-user/non-exist-user-id")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        businessId: "non-exist-business-id",
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
