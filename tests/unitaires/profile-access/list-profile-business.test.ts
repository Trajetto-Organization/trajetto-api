import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { ListProfileBusinessUseCase } from "@/modules/profile-access/usecases/list-profile-business/list-profile-business-usecase";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("List Profile Business Use Case", () => {
  let userInMemory: InMemoryUserRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let listProfileBusinessUseCase: ListProfileBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    businessInMemory = new InMemoryBusinessRepository();
    listProfileBusinessUseCase = new ListProfileBusinessUseCase(
      userInMemory,
      profileAccessInMemory,
      businessInMemory,
    );
  });

  it("should be able to list all profile access", async () => {
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: createdBusiness.id as string,
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Profile Access 1",
      businessId: createdBusiness.id as string,
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Profile Access 2",
      businessId: createdBusiness.id as string,
    });

    const result = await listProfileBusinessUseCase.execute(
      createdUser.id,
      1,
      10,
      createdBusiness.id as string,
    );

    expect(result.data.length).toBe(2);

    expect(result.data[0].name).toBe("Profile Access 1");
    expect(result.data[1].name).toBe("Profile Access 2");

    expect(result.total).toBe(2);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
    });

    await expect(
      listProfileBusinessUseCase.execute(
        createdUser.id,
        1,
        10,
        "some-business-id",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listProfileBusinessUseCase.execute(
        "non-user-id",
        1,
        10,
        "non-business-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if list profile business operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
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

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    // 🛠 Simulates an error when deleting the access profile
    vi.spyOn(
      profileAccessInMemory,
      "listProfileBusiness",
    ).mockImplementationOnce(async () => {
      throw new Error("Simulated list failure");
    });

    await expect(
      listProfileBusinessUseCase.execute(
        createdUser.id,
        1,
        10,
        createdBusiness.id as string,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
