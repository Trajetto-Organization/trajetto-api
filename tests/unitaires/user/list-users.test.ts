import { describe, it, expect, beforeEach, vi } from "vitest";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ListUsersUseCase } from "@/modules/user/usecases/list-users/list-users-usecase";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { AppError } from "@/shared/errors/AppError";

describe("List Users UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let listUsersUseCase: ListUsersUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    listUsersUseCase = new ListUsersUseCase(userInMemory);
  });

  it("should list users successfully", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await userInMemory.createUser({
      email: "user1@example.com",
      password: "hashed",
      name: "User One",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-2",
    });

    await userInMemory.createUser({
      email: "user2@example.com",
      password: "hashed",
      name: "User Two",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-3",
    });

    const result = await listUsersUseCase.execute(adminUser.id, 1, 10, "");

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("total");

    expect(result.total).toBe(3);
  });

  it("should throw ResourceNotFoundError if calling user is not found", async () => {
    await expect(
      listUsersUseCase.execute("non-existent-id", 1, 10, ""),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if listUsers fails internally", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashed",
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    vi.spyOn(userInMemory, "listUsers").mockImplementationOnce(async () => {
      throw new Error("Internal error");
    });

    await expect(
      listUsersUseCase.execute(adminUser.id, 1, 10, ""),
    ).rejects.toEqual(
      new AppError("Não foi possível recuperar a lista de usuários!", 500),
    );
  });
});
