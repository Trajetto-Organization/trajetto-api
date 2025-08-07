import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";

import { CreatePermissionUseCase } from "@/modules/permission/usecases/create-permission/create-permission-usecase";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ProfileAccessNotFoundError } from "@/modules/user/usecases/errors/profile-access-not-found-error";
import { PermissionBusinessError } from "@/modules/permission/usecases/errors/permission-business-error";

import { PermissionAlreadyExistsError } from "@/modules/permission/usecases/errors/permission-already-exists-error";
import { PermissionAlreadyAssignedError } from "@/modules/permission/usecases/errors/permission-already-assigned-error";

describe("Create Permission UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let permissionInMemory: InMemoryPermissionRepository;

  let businessInMemory: InMemoryBusinessRepository;
  let profileAccessInMemory: InMemoryProfileAccessRepository;

  let createPermission: CreatePermissionUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    permissionInMemory = new InMemoryPermissionRepository();

    businessInMemory = new InMemoryBusinessRepository();
    profileAccessInMemory = new InMemoryProfileAccessRepository();

    createPermission = new CreatePermissionUseCase(
      userInMemory,
      permissionInMemory,
      businessInMemory,
      profileAccessInMemory,
    );
  });

  it("should create a permission successfully", async () => {
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

    const permission = await createPermission.execute(
      {
        action: "New Permission Action",
        businessId: createdBusiness.id as string,
        canRead: true,
        canWrite: true,
        permissionKey: "profile_access_manage",
        profileAccessId: createdProfileAccess.id,
      },
      createdUser.id,
    );

    expect(permission).toHaveProperty("id");

    expect(permission.action).toEqual("New Permission Action");
    expect(permission.permissionKey).toEqual("profile_access_manage");
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const createdBusiness = await businessInMemory.createBusiness({
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
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access",
      });

    await expect(
      createPermission.execute(
        {
          action: "Test Action",
          businessId: createdBusiness.id as string,
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: createdProfileAccess.id,
        },
        "non-existing-user-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    await expect(
      createPermission.execute(
        {
          action: "Test Action",
          businessId: "non-existing-business",
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: "non-existing-profile",
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw ProfileAccessNotFoundError if profile access does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test2@example.com",
      password: "password",
      name: "Test User 2",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 2",
      cnpj: "22345678000100",
      fantasy_name: "Test Fantasia 2",
      cep: "12345678",
      city: "Test City",
      uf: "TS",
      street: "Test Street",
      address_number: "456",
      telephone: "2222222222",
      email: "business2@example.com",
      cnae: "7654321",
      responsible_name: "Responsible Person 2",
      erp_code: "ERP456",
    });

    await expect(
      createPermission.execute(
        {
          action: "Test Action",
          businessId: createdBusiness.id as string,
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: "non-existing-profile",
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessNotFoundError);
  });

  it("should throw PermissionBusinessError if profile access does not belong to business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test3@example.com",
      password: "password",
      name: "Test User 3",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    const createdBusiness1 = await businessInMemory.createBusiness({
      corporate_reason: "Business One",
      cnpj: "32345678000100",
      fantasy_name: "Fantasia One",
      cep: "12345678",
      city: "City One",
      uf: "CO",
      street: "Street One",
      address_number: "1",
      telephone: "3333333333",
      email: "business1@example.com",
      cnae: "1111111",
      responsible_name: "Responsible One",
      erp_code: "ERP1",
    });

    const createdBusiness2 = await businessInMemory.createBusiness({
      corporate_reason: "Business Two",
      cnpj: "42345678000100",
      fantasy_name: "Fantasia Two",
      cep: "12345678",
      city: "City Two",
      uf: "CT",
      street: "Street Two",
      address_number: "2",
      telephone: "4444444444",
      email: "business2@example.com",
      cnae: "2222222",
      responsible_name: "Responsible Two",
      erp_code: "ERP2",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness2.id as string,
        name: "Test Profile Access",
      });

    await expect(
      createPermission.execute(
        {
          action: "Test Action",
          businessId: createdBusiness1.id as string,
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(PermissionBusinessError);
  });

  it("should throw PermissionAlreadyExistsError if permission with same action already exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test4@example.com",
      password: "password",
      name: "Test User 4",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 4",
      cnpj: "52345678000100",
      fantasy_name: "Fantasia 4",
      cep: "12345678",
      city: "City 4",
      uf: "CF",
      street: "Street 4",
      address_number: "4",
      telephone: "5555555555",
      email: "business4@example.com",
      cnae: "4444444",
      responsible_name: "Responsible Four",
      erp_code: "ERP4",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 4",
      });

    await permissionInMemory.createPermission({
      action: "Test Action",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    });

    await expect(
      createPermission.execute(
        {
          action: "Test Action",
          businessId: createdBusiness.id as string,
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(PermissionAlreadyExistsError);
  });

  it("should throw PermissionAlreadyAssignedError if permission with same permissionKey already exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test5@example.com",
      password: "password",
      name: "Test User 5",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

    const createdBusiness = await businessInMemory.createBusiness({
      corporate_reason: "Test Business 5",
      cnpj: "62345678000100",
      fantasy_name: "Fantasia 5",
      cep: "12345678",
      city: "City 5",
      uf: "CS",
      street: "Street 5",
      address_number: "5",
      telephone: "6666666666",
      email: "business5@example.com",
      cnae: "5555555",
      responsible_name: "Responsible Five",
      erp_code: "ERP5",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: createdBusiness.id as string,
        name: "Test Profile Access 5",
      });

    await permissionInMemory.createPermission({
      action: "Some Action",
      businessId: createdBusiness.id as string,
      canRead: true,
      canWrite: true,
      permissionKey: "profile_access_manage",
      profileAccessId: createdProfileAccess.id,
    });

    await expect(
      createPermission.execute(
        {
          action: "Another Action",
          businessId: createdBusiness.id as string,
          canRead: true,
          canWrite: true,
          permissionKey: "profile_access_manage",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(PermissionAlreadyAssignedError);
  });

  it("should throw AppError if create operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test7@example.com",
      password: "password",
      name: "Test User 7",
      businessId: "dummy-business-id",
      profileAccessId: "dummy-profile-id",
      role: "MASTER",
    });

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
        businessId: createdBusiness.id as string as string,
        name: "Test Profile Access 7",
      });

    vi.spyOn(permissionInMemory, "createPermission").mockImplementationOnce(
      async () => {
        throw new Error("Simulated create failure");
      },
    );

    await expect(
      createPermission.execute(
        {
          action: "Permission",
          businessId: createdBusiness.id as string as string,
          canRead: false,
          canWrite: false,
          permissionKey: "profile_access_manage",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
