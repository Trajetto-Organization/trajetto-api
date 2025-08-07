import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { ListProfileAccessUseCase } from "@/modules/profile-access/usecases/list-profile-access/list-profile-access-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("List Profile Access UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let listProfileAccessUseCase: ListProfileAccessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    listProfileAccessUseCase = new ListProfileAccessUseCase(
      userInMemory,
      profileAccessInMemory,
    );
  });

  it("should be able to list all profile access", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "BUSINESS_USER",
    });

    const businessesData = [
      {
        name: "Profile Access 1",
        businessId: createdUser.businessId,
      },
      {
        name: "Profile Access 2",
        businessId: createdUser.businessId,
      },
    ];

    await Promise.all(
      businessesData.map((data) =>
        profileAccessInMemory.createProfileAccess({
          businessId: data.businessId as string,
          name: data.name,
        }),
      ),
    );

    const result = await listProfileAccessUseCase.execute(
      createdUser.id,
      1,
      10,
    );

    expect(result.data.length).toBe(2);

    expect(result.data[0].name).toBe("Profile Access 1");
    expect(result.data[1].name).toBe("Profile Access 2");

    expect(result.total).toBe(2);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listProfileAccessUseCase.execute("non-user-id", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if list profile access operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "BUSINESS_USER",
    });

    // 🛠 Simulates an error when deleting the access profile
    vi.spyOn(profileAccessInMemory, "listProfileAccess").mockImplementationOnce(
      async () => {
        throw new Error("Simulated list failure");
      },
    );

    await expect(
      listProfileAccessUseCase.execute(createdUser.id, 1, 10),
    ).rejects.toBeInstanceOf(AppError);
  });
});
