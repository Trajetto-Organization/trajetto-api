import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { DeletePermissionUseCase } from "@/modules/permission/usecases/delete-permission/delete-permission-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { PermissionCannotBeDeletedByHimselfError } from "@/modules/permission/usecases/errors/permission-cannot-be-deleted-by-himself-error";
import { PermissionNotFoundError } from "@/modules/permission/usecases/errors/permission-not-found-error";

import { AppError } from "@/shared/errors/AppError";

describe("Delete Permission UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let permissionInMemory: InMemoryPermissionRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let deletePermission: DeletePermissionUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    permissionInMemory = new InMemoryPermissionRepository();

    businessInMemory = new InMemoryBusinessRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    deletePermission = new DeletePermissionUseCase(
      userInMemory,
      permissionInMemory,
    );
  });

  it("should delete the permission successfully", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 6",
      cnpj: "72345678000100",
      fantasy_name: "Fantasia 6",
      cep: "12345678",
      city: "City 6",
      uf: "CT",
      street: "Street 6",
      address_number: "6",
      telephone: "7777777777",
      email: "business6@example.com",
      cnae: "6666666",
      responsible_name: "Responsible Six",
      erp_code: "ERP6",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 6",
      });

    const permission = await permissionInMemory.createPermission({
      action: "New Permission Action",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    });

    const deletedPermission = await deletePermission.execute(
      permission.id,
      createdUser.id,
    );
    expect(deletedPermission.id).toEqual(permission.id);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      deletePermission.execute("some-permission-id", "non-existing-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw PermissionCannotBeDeletedByHimselfError if user tries to delete a permission from their own profile", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 6",
      cnpj: "72345678000100",
      fantasy_name: "Fantasia 6",
      cep: "12345678",
      city: "City 6",
      uf: "CT",
      street: "Street 6",
      address_number: "6",
      telephone: "7777777777",
      email: "business6@example.com",
      cnae: "6666666",
      responsible_name: "Responsible Six",
      erp_code: "ERP6",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 6",
      });

    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    const createdPermission = await permissionInMemory.createPermission({
      action: "New Permission Action",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    });

    createdUser.profileAccess = {
      name: createdProfileAccess.name,
      permissions: [
        {
          id: createdPermission.id,
          action: createdPermission.action,
          permissionKey: createdPermission.permissionKey as string,
          canRead: createdPermission.canRead,
          canWrite: createdPermission.canWrite,
        },
      ],
    };

    await expect(
      deletePermission.execute(createdPermission.id, createdUser.id),
    ).rejects.toBeInstanceOf(PermissionCannotBeDeletedByHimselfError);
  });

  it("should throw PermissionNotFoundError if the permission does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: "non-business-id",
      profileAccessId: "non-profile-id",
      role: "MASTER",
    });

    await expect(
      deletePermission.execute("non-existing-permission", createdUser.id),
    ).rejects.toBeInstanceOf(PermissionNotFoundError);
  });

  it("should throw AppError if deletion fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test6@example.com",
      password: "password",
      name: "Test User 6",
      businessId: "non-business-id",
      profileAccessId: "non-profile-id",
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action",
      canRead: true,
      canWrite: true,
      businessId: "non-business-id",
      profileAccessId: "non-profile-id",
      permissionKey: "profile_access_manage",
    });

    vi.spyOn(permissionInMemory, "deletePermission").mockImplementationOnce(
      async () => {
        throw new Error("Simulated deletion failure");
      },
    );

    await expect(
      deletePermission.execute(permission.id, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
