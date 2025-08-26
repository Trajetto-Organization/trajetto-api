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

  it("should handle pagination correctly", async () => {
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

    // Create 5 profiles for this business
    for (let i = 1; i <= 5; i++) {
      await profileAccessInMemory.createProfileAccess({
        name: `Profile ${i}`,
        businessId: createdBusiness.id as string,
      });
    }

    // Get first page (2 items)
    const firstPage = await listProfileBusinessUseCase.execute(
      createdUser.id,
      1,
      2,
      createdBusiness.id as string,
    );

    expect(firstPage.data.length).toBe(2);
    expect(firstPage.total).toBe(5);

    // Get second page (2 items)
    const secondPage = await listProfileBusinessUseCase.execute(
      createdUser.id,
      2,
      2,
      createdBusiness.id as string,
    );

    expect(secondPage.data.length).toBe(2);
    expect(secondPage.total).toBe(5);
  });

  it("should return only profiles for the specified business", async () => {
    const businessData1 = {
      corporate_reason: "Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Business 1 Fantasy",
      cep: "12345678",
      city: "City 1",
      uf: "TS",
      street: "Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Business 2 Fantasy",
      cep: "87654321",
      city: "City 2",
      uf: "TS",
      street: "Street 2",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible 2",
      erp_code: "ERP456",
    };

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: business1.id as string,
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
    });

    // Create profiles for business 1
    await profileAccessInMemory.createProfileAccess({
      name: "Business 1 Profile 1",
      businessId: business1.id as string,
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Business 1 Profile 2",
      businessId: business1.id as string,
    });

    // Create profile for business 2 (should not be returned)
    await profileAccessInMemory.createProfileAccess({
      name: "Business 2 Profile",
      businessId: business2.id as string,
    });

    const result = await listProfileBusinessUseCase.execute(
      createdUser.id,
      1,
      10,
      business1.id as string,
    );

    expect(result.data.length).toBe(2);
    expect(result.total).toBe(2);
    expect(result.data[0].name).toBe("Business 1 Profile 1");
    expect(result.data[1].name).toBe("Business 1 Profile 2");
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

    // 🛠 Simulates an error when listing profile business
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
