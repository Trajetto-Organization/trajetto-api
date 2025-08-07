import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ListBusinessUseCase } from "@/modules/business/usecases/list-business/list-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let businessInMemory: InMemoryBusinessRepository;

let listBusiness: ListBusinessUseCase;

describe("List Business UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    listBusiness = new ListBusinessUseCase(userInMemory, businessInMemory);
  });

  it("should be able to list all business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

    const businessesData = [
      {
        corporate_reason: "Business 1",
        cnpj: "12345678000100",
        fantasy_name: "Fantasy 1",
        cep: "12345678",
        city: "City 1",
        uf: "SP",
        street: "Street 1",
        address_number: "100",
        telephone: "1111111111",
        email: "biz1@example.com",
        cnae: "1234567",
        responsible_name: "Example Test",
      },
      {
        corporate_reason: "Business 2",
        cnpj: "12345678000200",
        fantasy_name: "Fantasy 2",
        cep: "87654321",
        city: "City 2",
        uf: "RJ",
        street: "Street 2",
        address_number: "200",
        telephone: "2222222222",
        email: "biz2@example.com",
        cnae: "1234567",
        responsible_name: "Example Test",
      },
    ];

    await Promise.all(
      businessesData.map((data) => businessInMemory.createBusiness(data)),
    );

    const result = await listBusiness.execute(createdUser.id, 1, 10);

    expect(result.data.length).toBe(2);

    expect(result.data[0].corporate_reason).toBe("Business 1");
    expect(result.data[1].corporate_reason).toBe("Business 2");

    expect(result.total).toBe(2);
  });

  it("should throw ResourceNotFoundError if user was not found", async () => {
    await expect(
      listBusiness.execute("non-existing-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if business repository fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

    vi.spyOn(businessInMemory, "listBusiness").mockImplementation(async () => {
      throw new Error("Simulated failure");
    });

    await expect(
      listBusiness.execute(createdUser.id, 1, 10),
    ).rejects.toBeInstanceOf(AppError);
  });
});
