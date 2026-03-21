import { describe, it, expect, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { UpdateUserUseCase } from "@/modules/user/usecases/update-user/update-user-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "@/modules/user/usecases/errors/user-cannot-be-updated-by-himself-error";

import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";
import { UserProfileNotMatchBusinessError } from "@/modules/user/usecases/errors/user-profile-not-match-business-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { UserAlreadyExistsError } from "@/modules/user/usecases/errors/user-already-exists.error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { AppError } from "@/shared/errors/AppError";

describe("Update User UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let profileAccessInMemory: InMemoryProfileAccessRepository;
  let notificationService: NotificationService;

  let driverInMemory: InMemoryDriverRepository;
  let updateUserUseCase: UpdateUserUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    profileAccessInMemory = new InMemoryProfileAccessRepository();

    // Create a mock NotificationService
    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;
    driverInMemory = new InMemoryDriverRepository();

    updateUserUseCase = new UpdateUserUseCase(
      userInMemory,
      businessInMemory,
      profileAccessInMemory,
      notificationService,
      driverInMemory,
    );
  });

  it("should update a user successfully", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "dummy",
      profileAccessId: "profile-1",
    });

    adminUser.role = "MASTER";

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      businessId: "dummy",
      profileAccessId: "profile-2",
    });

    userToUpdate.businessId = "business-1";

    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Fantasy 1",
      cep: "12345678",
      city: "City 1",
      uf: "ST",
      street: "Street 1",
      address_number: "100",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible",
      erp_code: "ERP123",
    });

    userToUpdate.businessId = business.id;

    const newProfileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "New Profile",
    });

    const updatedUser = await updateUserUseCase.execute(
      {
        userId: userToUpdate.id,
        userData: {
          email: "newuser@example.com",
          password: "newpass",
          name: "New User Name",
          role: "BUSINESS_USER",
          businessId: business.id as string,
          profileAccessId: newProfileAccess.id,
        },
      },
      adminUser.id,
    );

    expect(updatedUser.email).toBe("newuser@example.com");
    expect(updatedUser.name).toBe("New User Name");
  });

  it("should throw ResourceNotFoundError if admin user is not found", async () => {
    await expect(
      updateUserUseCase.execute(
        {
          userId: "some-id",
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: "business-1",
            profileAccessId: "profile-2",
          },
        },
        "non-existent-admin",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw UserCannotBeUpdatedByHimselfError if admin tries to update itself", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: adminUser.id,
          userData: {
            email: "new@example.com",
            name: "New Name",
            role: "BUSINESS_USER",
            businessId: "business-1",
            profileAccessId: "profile-2",
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserCannotBeUpdatedByHimselfError);
  });

  it("should throw ResourceNotFoundError if user to update is not found", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: "non-existent-user",
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: "business-1",
            profileAccessId: "profile-2",
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ProfileAccessNotFoundError if the provided profileAccessId does not exist", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-2",
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: "business-1",
            profileAccessId: "non-existent-profile",
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserProfileAccessNotFoundError);
  });

  it("should throw UserProfileNotMatchBusinessError if the provided profileAccess does not belong to the same business as the user", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-2",
    });

    const diffProfileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: "different-business",
      name: "Different Profile",
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: "business-1",
            profileAccessId: diffProfileAccess.id,
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserProfileNotMatchBusinessError);
  });

  it("should throw BusinessNotFoundError if the provided businessId does not exist", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-2",
    });

    userToUpdate.businessId = "business-1";

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: "non-existent-business",
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw UserAlreadyExistsError if the new email is already taken by another user", async () => {
    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Fantasy 1",
      cep: "12345678",
      city: "City 1",
      uf: "ST",
      street: "Street 1",
      address_number: "100",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible",
      erp_code: "ERP123",
    });

    const validProfileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Valid Profile",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      profileAccessId: validProfileAccess.id,
      businessId: business.id as string,
    });

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      profileAccessId: validProfileAccess.id,
      businessId: business.id as string,
    });

    userToUpdate.businessId = business.id;

    await userInMemory.createUser({
      email: "duplicate@example.com",
      password: await hash("pass", 6),
      name: "Duplicate User",
      role: "BUSINESS_USER",
      profileAccessId: validProfileAccess.id,
      businessId: business.id as string,
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            email: "duplicate@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: business.id as string,
            profileAccessId: validProfileAccess.id,
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  it("should throw AppError (403) if admin's role does not allow updating to the new role", async () => {
    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Fantasy 1",
      cep: "12345678",
      city: "City 1",
      uf: "ST",
      street: "Street 1",
      address_number: "100",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible",
      erp_code: "ERP123",
    });

    const validProfileAccess = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Valid Profile",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "BUSINESS_USER",
      profileAccessId: validProfileAccess.id,
      businessId: business.id as string,
    });

    adminUser.businessId = business.id;
    adminUser.role = "BUSINESS_USER";

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "MASTER",
      profileAccessId: validProfileAccess.id,
      businessId: business.id as string,
    });

    userToUpdate.businessId = business.id;
    userToUpdate.role = "MASTER";

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            role: "MASTER",
            email: "newuser@example.com",
            name: "New User",
            businessId: business.id as string,
            profileAccessId: validProfileAccess.id,
          },
        },
        adminUser.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should throw AppError (500) if an error occurs while updating the user", async () => {
    const business = await businessInMemory.createBusiness({
      corporate_reason: "Business 1",
      cnpj: "12345678000100",
      fantasy_name: "Fantasy 1",
      cep: "12345678",
      city: "City 1",
      uf: "ST",
      street: "Street 1",
      address_number: "100",
      telephone: "1111111111",
      email: "business@example.com",
      cnae: "1234567",
      responsible_name: "Responsible",
      erp_code: "ERP123",
    });

    const adminProfile = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "Admin Profile",
    });

    const userProfile = await profileAccessInMemory.createProfileAccess({
      businessId: business.id as string,
      name: "User Profile",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: await hash("adminpass", 6),
      name: "Admin User",
      role: "MASTER",
      businessId: business.id as string,
      profileAccessId: adminProfile.id,
    });

    adminUser.businessId = business.id;
    adminUser.role = "MASTER";

    const userToUpdate = await userInMemory.createUser({
      email: "olduser@example.com",
      password: await hash("oldpass", 6),
      name: "Old User",
      role: "BUSINESS_USER",
      businessId: business.id as string,
      profileAccessId: userProfile.id,
    });

    userToUpdate.businessId = business.id;
    userToUpdate.role = "BUSINESS_USER";

    vi.spyOn(userInMemory, "updateUser").mockImplementationOnce(async () => {
      throw new Error("Internal error");
    });

    await expect(
      updateUserUseCase.execute(
        {
          userId: userToUpdate.id,
          userData: {
            email: "newuser@example.com",
            name: "New User",
            role: "BUSINESS_USER",
            businessId: business.id as string,
            profileAccessId: userProfile.id,
          },
        },
        adminUser.id,
      ),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar o usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
