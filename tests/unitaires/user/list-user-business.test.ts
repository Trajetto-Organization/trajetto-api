import { describe, it, expect, beforeEach, vi } from "vitest";

import { ListUserBusinessUseCase } from "@/modules/user/usecases/list-user-business/list-user-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { AppError } from "@/shared/errors/AppError";

describe("List User Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let listUserBusinessUseCase: ListUserBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    listUserBusinessUseCase = new ListUserBusinessUseCase(
      userInMemory,
      businessInMemory,
    );
  });

  it("should be able to list users by business", async () => {
    const business = await businessInMemory.createBusiness({
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
    });

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: "profile-id",
    });

    await userInMemory.createUser({
      email: "user2@example.com",
      password: "hashedpassword2",
      name: "Test User 2",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: "profile-id-2",
    });

    const result = await listUserBusinessUseCase.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();

    expect(result.data.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    const business = await businessInMemory.createBusiness({
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
    });

    await expect(
      listUserBusinessUseCase.execute(
        "non-existent-user-id",
        1,
        10,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business is not found", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await expect(
      listUserBusinessUseCase.execute(
        user.id,
        1,
        10,
        "non-existent-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if an error occurs during listing process", async () => {
    const business = await businessInMemory.createBusiness({
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
    });

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: "profile-id",
    });

    vi.spyOn(userInMemory, "listUserBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Database error");
      },
    );

    await expect(
      listUserBusinessUseCase.execute(user.id, 1, 10, business.id as string),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível recuperar a lista dos usuários por empresa!",
        500,
      ),
    );
  });

  it("should handle pagination parameters correctly", async () => {
    const business = await businessInMemory.createBusiness({
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
    });

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: "profile-id",
    });

    const spyListUserBusiness = vi.spyOn(userInMemory, "listUserBusiness");

    await listUserBusinessUseCase.execute(user.id, 2, 5, business.id as string);

    expect(spyListUserBusiness).toHaveBeenCalledWith({
      page: 2,
      pageSize: 5,
      businessId: business.id as string,
    });
  });
});
