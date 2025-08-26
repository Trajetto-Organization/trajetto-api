import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";

import { ListPermissionUseCase } from "@/modules/permission/usecases/list-permission/list-permission-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";

describe("List Permission UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let permissionInMemory: InMemoryPermissionRepository;

  let listPermissionUseCase: ListPermissionUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    permissionInMemory = new InMemoryPermissionRepository();

    listPermissionUseCase = new ListPermissionUseCase(
      userInMemory,
      permissionInMemory,
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listPermissionUseCase.execute("non-existing-user", 1, 10),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if permission listing fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    vi.spyOn(permissionInMemory, "listPermission").mockRejectedValueOnce(
      new Error("Simulated error"),
    );

    await expect(
      listPermissionUseCase.execute(createdUser.id, 1, 10),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should list permissions successfully for MASTER user", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    await permissionInMemory.createPermission({
      action: "Action 1",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: createdUser.businessId as string,
      profileAccessId: createdUser.profileAccessId as string,
    });

    await permissionInMemory.createPermission({
      action: "Action 2",
      permissionKey: "user_permission_manage",
      canRead: true,
      canWrite: false,
      businessId: "other-business-id",
      profileAccessId: "other-profile-id",
    });

    const result = await listPermissionUseCase.execute(createdUser.id, 1, 10);

    expect(result.total).toEqual(2);
    expect(result.data).toHaveLength(2);

    expect(result.data[0]).toHaveProperty("id");
    expect(result.data[0]).toHaveProperty("action");

    expect(result.data[0]).toHaveProperty("canRead");
    expect(result.data[0]).toHaveProperty("canWrite");
  });

  it("should list permissions for BUSINESS_ADMIN user filtered by business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "password",
      name: "Admin User",
      businessId: "business-123",
      profileAccessId: "profile-456",
      role: "BUSINESS_ADMIN",
    });

    // Permission from same business
    await permissionInMemory.createPermission({
      action: "Same Business Action",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business-123",
      profileAccessId: "profile-456",
    });

    // Permission from different business (should not appear)
    await permissionInMemory.createPermission({
      action: "Different Business Action",
      permissionKey: "user_registration_manage",
      canRead: true,
      canWrite: false,
      businessId: "other-business",
      profileAccessId: "other-profile",
    });

    const result = await listPermissionUseCase.execute(createdUser.id, 1, 10);

    expect(result.total).toEqual(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].action).toBe("Same Business Action");
  });

  it("should list permissions for BUSINESS_USER filtered by business and profile", async () => {
    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "password",
      name: "Business User",
      businessId: "business-123",
      profileAccessId: "profile-456",
      role: "BUSINESS_USER",
    });

    // Permission from same business and profile
    await permissionInMemory.createPermission({
      action: "User Profile Action",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business-123",
      profileAccessId: "profile-456",
    });

    // Permission from same business but different profile (should not appear)
    await permissionInMemory.createPermission({
      action: "Other Profile Action",
      permissionKey: "user_registration_manage",
      canRead: true,
      canWrite: false,
      businessId: "business-123",
      profileAccessId: "other-profile",
    });

    const result = await listPermissionUseCase.execute(createdUser.id, 1, 10);

    expect(result.total).toEqual(1);
    expect(result.data).toHaveLength(1);

    expect(result.data[0].action).toBe("User Profile Action");
  });

  it("should filter permissions by search term", async () => {
    const createdUser = await userInMemory.createUser({
      email: "search@example.com",
      password: "password",
      name: "Search User",
      businessId: "business-123",
      profileAccessId: "profile-456",
      role: "MASTER",
    });

    await permissionInMemory.createPermission({
      action: "Create User Action",
      permissionKey: "user_registration_manage",
      canRead: true,
      canWrite: true,
      businessId: "business-123",
      profileAccessId: "profile-456",
    });

    await permissionInMemory.createPermission({
      action: "Delete Profile Action",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: false,
      businessId: "business-123",
      profileAccessId: "profile-456",
    });

    // Search by action
    const result1 = await listPermissionUseCase.execute(
      createdUser.id,
      1,
      10,
      "User",
    );
    expect(result1.total).toEqual(1);
    expect(result1.data[0].action).toBe("Create User Action");

    // Search by permission key
    const result2 = await listPermissionUseCase.execute(
      createdUser.id,
      1,
      10,
      "profile_access",
    );
    expect(result2.total).toEqual(1);
    expect(result2.data[0].action).toBe("Delete Profile Action");
  });

  it("should handle pagination correctly", async () => {
    const createdUser = await userInMemory.createUser({
      email: "pagination@example.com",
      password: "password",
      name: "Pagination User",
      businessId: "business-123",
      profileAccessId: "profile-456",
      role: "MASTER",
    });

    // Create 3 permissions
    for (let i = 1; i <= 3; i++) {
      await permissionInMemory.createPermission({
        action: `Action ${i}`,
        permissionKey: "profile_access_manage",
        canRead: true,
        canWrite: true,
        businessId: "business-123",
        profileAccessId: "profile-456",
      });
    }

    // Get first page with 2 items per page
    const page1 = await listPermissionUseCase.execute(createdUser.id, 1, 2);
    expect(page1.total).toEqual(3);
    expect(page1.data).toHaveLength(2);

    // Get second page with 2 items per page
    const page2 = await listPermissionUseCase.execute(createdUser.id, 2, 2);
    expect(page2.total).toEqual(3);
    expect(page2.data).toHaveLength(1);
  });
});
