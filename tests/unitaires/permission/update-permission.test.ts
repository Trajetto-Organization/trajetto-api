import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { UpdatePermissionUseCase } from "@/modules/permission/usecases/update-permission/update-permission-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { PermissionCannotBeUpdatedByHimselfError } from "@/modules/permission/usecases/errors/permission-cannot-be-updated-by-himself-error";

import { PermissionNotFoundError } from "@/modules/permission/usecases/errors/permission-not-found-error";
import { PermissionAlreadyExistsError } from "@/modules/permission/usecases/errors/permission-already-exists-error";

import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";
import { PermissionBusinessError } from "@/modules/permission/usecases/errors/permission-business-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

describe("Update Permission UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let permissionInMemory: InMemoryPermissionRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let notificationService: NotificationService;
  let updatePermissionUseCase: UpdatePermissionUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    permissionInMemory = new InMemoryPermissionRepository();

    businessInMemory = new InMemoryBusinessRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    // Create a mock NotificationService
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    updatePermissionUseCase = new UpdatePermissionUseCase(
      userInMemory,
      permissionInMemory,
      businessInMemory,
      profileAccessInMemory,
      notificationService,
    );
  });

  it("should update permission successfully", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 5",
      cnpj: "82345678000100",
      fantasy_name: "Fantasia 5",
      cep: "12345678",
      city: "City 5",
      uf: "CU",
      street: "Street 5",
      address_number: "5",
      telephone: "8888888888",
      email: "business7@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Seven",
      erp_code: "ERP5",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 5",
      });

    const user = await userInMemory.createUser({
      email: "user5@example.com",
      password: "pass",
      name: "Test User 5",
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action 5",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
    });

    const updatedData = {
      permissionId: permission.id,
      action: "Updated Action 8",
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
    };

    const updatedPermission = await updatePermissionUseCase.execute(
      updatedData,
      user.id,
    );

    expect(updatedPermission.id).toEqual(permission.id);
    expect(updatedPermission.action).toEqual("Updated Action 8");

    // Verify that notification service was called
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Permissão",
      action: "update",
      entityId: permission.id,
      description: expect.stringContaining(
        "Permissão atualizada com sucesso: Updated Action 8",
      ),
      status: "Atualizado",
      performedBy: user.id,
      businessId: createdBusiness.id,
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: "non-existing-permission",
          action: "Updated Action",
          businessId: "business1",
          profileAccessId: "profile1",
        },
        "non-existing-user",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw PermissionCannotBeUpdatedByHimselfError if user tries to update his own permission", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "pass",
      name: "Test User",
      businessId: "business1",
      profileAccessId: "profile1",
      role: "MASTER",
    });

    user.profileAccess = {
      name: "Profile 1",
      permissions: [
        {
          id: "perm1",
          action: "Action",
          permissionKey: "key1",
          canRead: true,
          canWrite: true,
        },
      ],
    };

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: "perm1",
          action: "Updated Action",
          businessId: "business1",
          profileAccessId: "profile1",
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(PermissionCannotBeUpdatedByHimselfError);
  });

  it("should throw PermissionNotFoundError if permission does not exist", async () => {
    const user = await userInMemory.createUser({
      email: "user2@example.com",
      password: "pass",
      name: "Test User 2",
      businessId: "business2",
      profileAccessId: "profile2",
      role: "MASTER",
    });

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: "non-existing-permission",
          action: "Updated Action",
          businessId: "business2",
          profileAccessId: "profile2",
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(PermissionNotFoundError);
  });

  it("should throw PermissionAlreadyExistsError if a permission with same action already exists", async () => {
    const user = await userInMemory.createUser({
      email: "user3@example.com",
      password: "pass",
      name: "Test User 3",
      businessId: "business3",
      profileAccessId: "profile3",
      role: "MASTER",
    });

    const permissionToUpdate = await permissionInMemory.createPermission({
      action: "Original Action",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business3",
      profileAccessId: "profile3",
    });

    await permissionInMemory.createPermission({
      action: "Updated Action",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business3",
      profileAccessId: "profile3",
    });

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: permissionToUpdate.id,
          action: "Updated Action",
          businessId: "business3",
          profileAccessId: "profile3",
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(PermissionAlreadyExistsError);
  });

  it("should throw ProfileAccessNotFoundError if profile access does not exist", async () => {
    const user = await userInMemory.createUser({
      email: "user4@example.com",
      password: "pass",
      name: "Test User 4",
      businessId: "business4",
      profileAccessId: "profile4",
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action 4",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business4",
      profileAccessId: "profile4",
    });

    vi.spyOn(
      profileAccessInMemory,
      "findProfileAccessById",
    ).mockResolvedValueOnce(null);

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: permission.id,
          action: "Updated Action 4",
          businessId: "business4",
          profileAccessId: "profile4",
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessNotFoundError);
  });

  it("should throw PermissionBusinessError if profile access does not belong to the same business", async () => {
    const user = await userInMemory.createUser({
      email: "user5@example.com",
      password: "pass",
      name: "Test User 5",
      businessId: "business5",
      profileAccessId: "profile5",
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action 5",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: "business5",
      profileAccessId: "profile5",
    });

    const otherProfileAccess = {
      id: "profile-diff",
      businessId: "other-business",
      name: "Other Profile",
    };
    vi.spyOn(
      profileAccessInMemory,
      "findProfileAccessById",
    ).mockResolvedValueOnce(otherProfileAccess as any);

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: permission.id,
          action: "Updated Action 5",
          businessId: "business5",
          profileAccessId: "profile5",
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(PermissionBusinessError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 6",
      cnpj: "82345678000100",
      fantasy_name: "Fantasia 6",
      cep: "12345678",
      city: "City 6",
      uf: "CU",
      street: "Street 6",
      address_number: "6",
      telephone: "8888888888",
      email: "business7@example.com",
      cnae: "1111111",
      responsible_name: "Responsible Seven",
      erp_code: "ERP6",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 6",
      });

    const user = await userInMemory.createUser({
      email: "user7@example.com",
      password: "pass",
      name: "Test User 6",
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action 6",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
    });

    vi.spyOn(businessInMemory, "findBusinessById").mockResolvedValueOnce(null);

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: permission.id,
          action: "Updated Action 6",
          businessId: createdBusiness.id as string,
          profileAccessId: createdProfileAccess.id,
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if update operation fails", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 7",
      cnpj: "82345678000100",
      fantasy_name: "Fantasia 7",
      cep: "12345678",
      city: "City 7",
      uf: "CU",
      street: "Street 7",
      address_number: "7",
      telephone: "8888888888",
      email: "business7@example.com",
      cnae: "7777777",
      responsible_name: "Responsible Seven",
      erp_code: "ERP7",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 7",
      });

    const user = await userInMemory.createUser({
      email: "user7@example.com",
      password: "pass",
      name: "Test User 7",
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    const permission = await permissionInMemory.createPermission({
      action: "Action 7",
      permissionKey: "profile_access_manage",
      canRead: true,
      canWrite: true,
      businessId: createdBusiness.id as string,
      profileAccessId: createdProfileAccess.id,
    });

    vi.spyOn(permissionInMemory, "updatePermission").mockImplementationOnce(
      async () => {
        throw new Error("Simulated update failure");
      },
    );

    await expect(
      updatePermissionUseCase.execute(
        {
          permissionId: permission.id,
          action: "Updated Action 7",
          businessId: createdBusiness.id as string,
          profileAccessId: createdProfileAccess.id,
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
