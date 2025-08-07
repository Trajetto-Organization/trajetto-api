import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { CreateBusinessUseCase } from "@/modules/business/usecases/create-business/create-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { CnpjAlreadyExistsError } from "@/modules/business/usecases/errors/cnpj-already-exists-error";
import { CorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/corporate-reason-already-exists-error";

import { ErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/erp-code-already-exists-error";
import { EmailAlreadyExistsError } from "@/modules/business/usecases/errors/email-already-exists-error";

import { AppError } from "@/shared/errors/AppError";

describe("Create Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let createBusiness: CreateBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    createBusiness = new CreateBusinessUseCase(userInMemory, businessInMemory);
  });

  it("should be able to create a business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    const createdBusiness = await createBusiness.execute(
      businessData,
      createdUser.id,
    );

    expect(createdBusiness).toHaveProperty("id");
    expect(createdBusiness.corporate_reason).toBe(
      businessData.corporate_reason,
    );

    expect(createdBusiness.cnpj).toBe(businessData.cnpj);
    expect(createdBusiness.email).toBe(businessData.email);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    await expect(
      createBusiness.execute(businessData, "non-existing-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw CnpjAlreadyExistsError if business with same cnpj exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    await createBusiness.execute(businessData, createdUser.id);
    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(CnpjAlreadyExistsError);
  });

  it("should throw CorporateReasonAlreadyExistsError if business with same corporate reason exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Unique Business",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Unique Business",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP456",
    };

    await createBusiness.execute(businessData1, createdUser.id);
    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(CorporateReasonAlreadyExistsError);
  });

  it("should throw ErpCodeAlreadyExistsError if business with same erp code exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Business One",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Business Two",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP123",
    };

    await createBusiness.execute(businessData1, createdUser.id);
    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(ErpCodeAlreadyExistsError);
  });

  it("should throw EmailAlreadyExistsError if business with same email exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData1 = {
      corporate_reason: "Business One",
      cnpj: "12345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "TS",
      street: "Street One",
      address_number: "123",
      telephone: "1111111111",
      email: "duplicate@example.com",
      cnae: "1234567",
      responsible_name: "Responsible One",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Business Two",
      cnpj: "12345678000200",
      fantasy_name: "Fantasia Two",
      cep: "87654321",
      city: "City Two",
      uf: "TS",
      street: "Street Two",
      address_number: "456",
      telephone: "2222222222",
      email: "duplicate@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Two",
      erp_code: "ERP456",
    };

    await createBusiness.execute(businessData1, createdUser.id);

    await expect(
      createBusiness.execute(businessData2, createdUser.id),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });

  it("should throw AppError if create operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
      corporate_reason: "Test Business",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "123",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person",
      erp_code: "ERP123",
    };

    vi.spyOn(businessInMemory, "createBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createBusiness.execute(businessData, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
