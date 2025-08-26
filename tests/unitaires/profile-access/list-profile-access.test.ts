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

  it("should be able to list all profile access for BUSINESS_USER role", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-123",
      role: "BUSINESS_USER",
    });

    // Create profiles for the same business
    await profileAccessInMemory.createProfileAccess({
      name: "Profile Access 1",
      businessId: "business-123",
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Profile Access 2",
      businessId: "business-123",
    });

    // Create profile for different business (should be filtered out)
    await profileAccessInMemory.createProfileAccess({
      name: "Other Business Profile",
      businessId: "different-business",
    });

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

  it("should be able to list profile access for MASTER role (sees all)", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-123",
      profileAccessId: "profile-123",
      role: "MASTER",
    });

    // Create profiles for different businesses
    await profileAccessInMemory.createProfileAccess({
      name: "Business 1 Profile",
      businessId: "business-123",
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Business 2 Profile",
      businessId: "business-456",
    });

    const result = await listProfileAccessUseCase.execute(masterUser.id, 1, 10);

    // MASTER should see profiles from all businesses
    expect(result.data.length).toBe(2);
    expect(result.total).toBe(2);
  });

  it("should filter profile access by search term", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-123",
      role: "BUSINESS_USER",
    });

    await profileAccessInMemory.createProfileAccess({
      name: "Admin Profile",
      businessId: "business-123",
    });

    await profileAccessInMemory.createProfileAccess({
      name: "User Profile",
      businessId: "business-123",
    });

    const result = await listProfileAccessUseCase.execute(
      createdUser.id,
      1,
      10,
      "admin",
    );

    expect(result.data.length).toBe(1);
    expect(result.data[0].name).toBe("Admin Profile");
    expect(result.total).toBe(1);
  });

  it("should handle pagination correctly", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-123",
      role: "BUSINESS_USER",
    });

    // Create 5 profiles
    for (let i = 1; i <= 5; i++) {
      await profileAccessInMemory.createProfileAccess({
        name: `Profile ${i}`,
        businessId: "business-123",
      });
    }

    // Get first page (2 items)
    const firstPage = await listProfileAccessUseCase.execute(
      createdUser.id,
      1,
      2,
    );

    expect(firstPage.data.length).toBe(2);
    expect(firstPage.total).toBe(5);

    // Get second page (2 items)
    const secondPage = await listProfileAccessUseCase.execute(
      createdUser.id,
      2,
      2,
    );

    expect(secondPage.data.length).toBe(2);
    expect(secondPage.total).toBe(5);
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

    // 🛠 Simulates an error when listing profile access
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
