import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ListBranchUseCase } from "@/modules/branch/usecases/list-branch/list-branch-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Branch UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let branchInMemory: InMemoryBranchRepository;

  let listBranch: ListBranchUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    branchInMemory = new InMemoryBranchRepository();

    listBranch = new ListBranchUseCase(userInMemory, branchInMemory);
  });

  it("should be able to list branches for MASTER user", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create branches for different businesses
    const branch1Data = {
      corporate_reason: "Branch 1",
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
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Branch 2",
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
      businessId: "business-2",
    };

    const branch3Data = {
      corporate_reason: "Branch 3",
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
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);
    await branchInMemory.createBranch(branch3Data);

    const result = await listBranch.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(3); // MASTER sees all branches
    expect(result.total).toBe(3);

    expect(result.data[0].corporate_reason).toBe("Branch 1");
    expect(result.data[1].corporate_reason).toBe("Branch 2");

    expect(result.data[2].corporate_reason).toBe("Branch 3");
  });

  it("should be able to list branches for non-MASTER user (filtered by businessId)", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "BUSINESS_ADMIN" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create branches for different businesses
    const branch1Data = {
      corporate_reason: "Branch 1",
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
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Branch 2",
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
      businessId: "business-2", // Different business
    };

    const branch3Data = {
      corporate_reason: "Branch 3",
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
      businessId: "business-1", // Same business as user
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);

    await branchInMemory.createBranch(branch3Data);

    const result = await listBranch.execute(user.id, 1, 10);

    expect(result.data).toHaveLength(2); // Non-MASTER sees only branches from their business
    expect(result.total).toBe(2);

    expect(result.data[0].corporate_reason).toBe("Branch 1");
    expect(result.data[1].corporate_reason).toBe("Branch 3");

    expect(
      result.data.every((branch) => branch.businessId === "business-1"),
    ).toBe(true);
  });

  it("should be able to search branches by corporate reason", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branch1Data = {
      corporate_reason: "Technology Branch",
      cnpj: "11111111000111",
      fantasy_name: "Tech Fantasia",
      cep: "11111111",
      city: "Tech City",
      uf: "B1",
      street: "Tech Street",
      address_number: "111",
      telephone: "1111111111",
      email: "tech@example.com",
      cnae: "1111111",
      responsible_name: "Tech Responsible",
      erp_code: "ERP111",
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Marketing Division",
      cnpj: "22222222000222",
      fantasy_name: "Marketing Fantasia",
      cep: "22222222",
      city: "Marketing City",
      uf: "B2",
      street: "Marketing Street",
      address_number: "222",
      telephone: "2222222222",
      email: "marketing@example.com",
      cnae: "2222222",
      responsible_name: "Marketing Responsible",
      erp_code: "ERP222",
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);

    const result = await listBranch.execute(user.id, 1, 10, "Technology");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].corporate_reason).toBe("Technology Branch");
  });

  it("should be able to search branches by cnpj", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branch1Data = {
      corporate_reason: "Branch 1",
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
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Branch 2",
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
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);

    const result = await listBranch.execute(user.id, 1, 10, "11111111000111");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].cnpj).toBe("11111111000111");
  });

  it("should be able to search branches by email", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branch1Data = {
      corporate_reason: "Branch 1",
      cnpj: "11111111000111",
      fantasy_name: "Branch Fantasia 1",
      cep: "11111111",
      city: "Branch City 1",
      uf: "B1",
      street: "Branch Street 1",
      address_number: "111",
      telephone: "1111111111",
      email: "special@example.com",
      cnae: "1111111",
      responsible_name: "Branch Responsible 1",
      erp_code: "ERP111",
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Branch 2",
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
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);

    const result = await listBranch.execute(user.id, 1, 10, "special");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].email).toBe("special@example.com");
  });

  it("should be able to search branches by fantasy name", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branch1Data = {
      corporate_reason: "Branch 1",
      cnpj: "11111111000111",
      fantasy_name: "Unique Fantasy Name",
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
      businessId: "business-1",
    };

    const branch2Data = {
      corporate_reason: "Branch 2",
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
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branch1Data);
    await branchInMemory.createBranch(branch2Data);

    const result = await listBranch.execute(user.id, 1, 10, "Unique");

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].fantasy_name).toBe("Unique Fantasy Name");
  });

  it("should handle pagination correctly", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create 5 branches
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
        businessId: "business-1",
      };
      await branchInMemory.createBranch(branchData);
    }

    // Test first page (2 items per page)
    const firstPage = await listBranch.execute(user.id, 1, 2);

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.total).toBe(5);

    expect(firstPage.data[0].corporate_reason).toBe("Branch 1");
    expect(firstPage.data[1].corporate_reason).toBe("Branch 2");

    // Test second page
    const secondPage = await listBranch.execute(user.id, 2, 2);

    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.total).toBe(5);

    expect(secondPage.data[0].corporate_reason).toBe("Branch 3");
    expect(secondPage.data[1].corporate_reason).toBe("Branch 4");

    // Test third page (only 1 item)
    const thirdPage = await listBranch.execute(user.id, 3, 2);

    expect(thirdPage.data).toHaveLength(1);
    expect(thirdPage.total).toBe(5);

    expect(thirdPage.data[0].corporate_reason).toBe("Branch 5");
  });

  it("should return empty result when no branches match search", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const branchData = {
      corporate_reason: "Branch 1",
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
      businessId: "business-1",
    };

    await branchInMemory.createBranch(branchData);
    const result = await listBranch.execute(user.id, 1, 10, "nonexistent");

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listBranch.execute("non-existing-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if list operation fails", async () => {
    const userData = {
      email: "user@example.com",
      password: "password",
      name: "Regular User",
      businessId: "business-1",
      profileAccessId: "some-profile-id",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(branchInMemory, "listAllBranches").mockImplementationOnce(
      async () => {
        throw new Error("Simulated list failure");
      },
    );

    await expect(listBranch.execute(user.id, 1, 10)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
