import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { ListBranchBusinessUseCase } from "@/modules/branch/usecases/list-branch-business/list-branch-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Branch Business UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let branchInMemory: InMemoryBranchRepository;
  let listBranchBusiness: ListBranchBusinessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    branchInMemory = new InMemoryBranchRepository();
    listBranchBusiness = new ListBranchBusinessUseCase(
      userInMemory,
      branchInMemory,
      businessInMemory,
    );
  });

  it("should be able to list branches by business", async () => {
    const businessData1 = {
      corporate_reason: "Test Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Test Fantasia 1",
      cep: "12345678",
      city: "Test City 1",
      uf: "TS",
      street: "Test Street 1",
      address_number: "123",
      telephone: "1111111111",
      email: "business1@example.com",
      cnae: "1234567",
      responsible_name: "Responsible Person 1",
      erp_code: "ERP123",
    };

    const businessData2 = {
      corporate_reason: "Test Business 2",
      cnpj: "98765432000100",
      fantasy_name: "Test Fantasia 2",
      cep: "87654321",
      city: "Test City 2",
      uf: "TS",
      street: "Test Street 2",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Person 2",
      erp_code: "ERP456",
    };

    const business1 = await businessInMemory.createBusiness(businessData1);
    const business2 = await businessInMemory.createBusiness(businessData2);

    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: business1.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create branches for business1
    const branch1Data = {
      corporate_reason: "Branch 1 - Business 1",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 1",
      cep: "11111111",
      city: "Branch City 1",
      uf: "B1",
      street: "Branch Street 1",
      address_number: "111",
      telephone: "1111111111",
      email: "branch1@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP111",
      businessId: business1.id as string,
    };

    const branch2Data = {
      corporate_reason: "Branch 2 - Business 1",
      cnpj: "22222222000222",
      fantasy_name: "Branch Fantasia 2",
      cep: "22222222",
      city: "Branch City 2",
      uf: "B2",
      street: "Branch Street 2",
      address_number: "222",
      telephone: "2222222222",
      email: "branch2@example.com",
      cnae: "2222222",
      responsible_name: "Branch Responsible 2",
      erp_code: "ERP222",
      businessId: business1.id as string,
    };

    // Create branch for business2 (should not appear in results)
    const branch3Data = {
      corporate_reason: "Branch 1 - Business 2",
      cnpj: "33333333000333",
      fantasy_name: "Branch Fantasia 3",
      cep: "33333333",
      city: "Branch City 3",
      uf: "B3",
      street: "Branch Street 3",
      address_number: "333",
      telephone: "3333333333",
      email: "branch3@example.com",
      cnae: "3333333",
      responsible_name: "Branch Responsible 3",
      erp_code: "ERP333",
      businessId: business2.id as string,
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);
    await branchInMemory.createBranch(branch3Data);

    const result = await listBranchBusiness.execute(
      user.id,
      1,
      10,
      business1.id as string,
    );

    expect(result.data).toHaveLength(2); // Only branches from business1
    expect(result.total).toBe(2);
    expect(result.data[0].corporate_reason).toBe("Branch 1 - Business 1");
    expect(result.data[1].corporate_reason).toBe("Branch 2 - Business 1");
    expect(
      result.data.every((branch) => branch.businessId === business1.id),
    ).toBe(true);
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

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create 5 branches for the business
    for (let i = 1; i <= 5; i++) {
      const branchData = {
        corporate_reason: `Branch ${i}`,
        cnpj: `${i.toString().padStart(2, "0")}${i.toString().padStart(2, "0")}${i.toString().padStart(2, "0")}${i.toString().padStart(2, "0")}000${i.toString().padStart(3, "0")}`,
        fantasy_name: `Branch Fantasia ${i}`,
        cep: `${i.toString().padStart(8, "0")}`,
        city: `Branch City ${i}`,
        uf: `B${i}`,
        street: `Branch Street ${i}`,
        address_number: i.toString(),
        telephone: i.toString().padStart(10, "0"),
        email: `branch${i}@example.com`,
        cnae: i.toString().padStart(7, "0"),
        responsible_name: `Branch Responsible ${i}`,
        erp_code: `ERP${i.toString().padStart(3, "0")}`,
        businessId: business.id as string,
      };
      await branchInMemory.createBranch(branchData);
    }

    // Test first page (2 items per page)
    const firstPage = await listBranchBusiness.execute(
      user.id,
      1,
      2,
      business.id as string,
    );
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.total).toBe(5);
    expect(firstPage.data[0].corporate_reason).toBe("Branch 1");
    expect(firstPage.data[1].corporate_reason).toBe("Branch 2");

    // Test second page
    const secondPage = await listBranchBusiness.execute(
      user.id,
      2,
      2,
      business.id as string,
    );
    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.total).toBe(5);
    expect(secondPage.data[0].corporate_reason).toBe("Branch 3");
    expect(secondPage.data[1].corporate_reason).toBe("Branch 4");

    // Test third page (only 1 item)
    const thirdPage = await listBranchBusiness.execute(
      user.id,
      3,
      2,
      business.id as string,
    );
    expect(thirdPage.data).toHaveLength(1);
    expect(thirdPage.total).toBe(5);
    expect(thirdPage.data[0].corporate_reason).toBe("Branch 5");
  });

  it("should return empty result when business has no branches", async () => {
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

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const result = await listBranchBusiness.execute(
      user.id,
      1,
      10,
      business.id as string,
    );

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
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

    const business = await businessInMemory.createBusiness(businessData);

    await expect(
      listBranchBusiness.execute(
        "non-existing-user-id",
        1,
        10,
        business.id as string,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    await expect(
      listBranchBusiness.execute(user.id, 1, 10, "non-existing-business-id"),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if list operation fails", async () => {
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

    const business = await businessInMemory.createBusiness(businessData);

    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Test User",
      businessId: business.id as string,
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(branchInMemory, "listBranchBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated list failure");
      },
    );

    await expect(
      listBranchBusiness.execute(user.id, 1, 10, business.id as string),
    ).rejects.toBeInstanceOf(AppError);
  });
});
