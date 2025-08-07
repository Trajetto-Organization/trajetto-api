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

  it("should list permissions successfully", async () => {
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
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: false,
      businessId: createdUser.businessId as string,
      profileAccessId: createdUser.profileAccessId as string,
    });

    const result = await listPermissionUseCase.execute(createdUser.id, 1, 10);

    expect(result.total).toEqual(2);
    expect(result.data).toHaveLength(2);

    expect(result.data[0]).toHaveProperty("id");
    expect(result.data[0]).toHaveProperty("action");

    expect(result.data[0]).toHaveProperty("canRead");
    expect(result.data[0]).toHaveProperty("canWrite");
  });
});
