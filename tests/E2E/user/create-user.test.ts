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

import { CreateUserUseCase } from "@/modules/user/usecases/create-user/create-user-usecase";
import prisma from "infra/database";

let userAuthenticated: string;

let uniqueCorporateReason: string;
let uniqueCNPJ: string;

let uniqueEmail: string;
let uniqueERPCode: string;

let originalExecuteMethod: any;

describe("Create User E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "MASTER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod = CreateUserUseCase.prototype.execute;
  });

  beforeEach(() => {
    uniqueCorporateReason = `Business Permission ${Date.now()}`;
    uniqueCNPJ = Math.random().toString().slice(2, 16);

    uniqueEmail = `test-${Date.now()}@example.com`;
    uniqueERPCode = `ERP-${Math.random().toString(36).substring(2, 6)}`;
  });

  afterEach(() => {
    CreateUserUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should be able to create a user", async () => {
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

    const business = await prisma.business.create({ data: businessData });
    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(201);
    expect(response.body.message).toBe("Usuário criado com sucesso!");
  });

  it("sshould throw UserProfileNotMatchBusinessError if profile access business does not match", async () => {
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

    const business = await prisma.business.create({ data: businessData });
    const profileAccess = await prisma.profileAccess.create({
      data: {
        businessId: business.id as string,
        name: "Profile Access",
      },
    });

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: "non-exist-business-id",
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(403);
    expect(response.body.message).toBe(
      "O perfil de acesso informado não pertence à mesma empresa do usuário.",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    CreateUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new ResourceNotFoundError();
    });

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: "example@example.com",
        email: "example@example.com",
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: "non-exist-business-id",
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
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

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: "gabriel@example.com",
        name: "New Example",
        role: "BUSINESS_ADMIN",
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

    const response = await request(serverInstance)
      .post("/user/create-user")
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

  it("should return UserAlreadyExistsError if email is already in use", async () => {
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

    await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      });

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: await hash("1234567", 6),
        email: uniqueEmail,
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: business.id,
        profileAccessId: profileAccess.id,
      });

    expect(response.statusCode).toEqual(409);
    expect(response.body.message).toBe("Este usuário já foi cadastrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    CreateUserUseCase.prototype.execute = vi.fn().mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const response = await request(serverInstance)
      .post("/user/create-user")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({
        password: "example@example.com",
        email: "example@example.com",
        name: "New Example",
        role: "BUSINESS_USER",
        businessId: "non-exist-business-id",
        profileAccessId: "non-exist-profile-access-id",
      });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
