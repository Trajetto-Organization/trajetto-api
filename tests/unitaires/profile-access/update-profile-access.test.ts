import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UpdateProfileAccessUseCase } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-usecase";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";
import { ProfileAccessAlreadyExistsError } from "@/modules/profile-access/usecases/errors/profile-access-already-exists-error";

import { ProfileAccessCannotBeUpdatedByHimselfError } from "@/modules/profile-access/usecases/errors/profile-access-cannot-be-updated-by-himself-error";

import { AppError } from "@/shared/errors/AppError";

describe("Update Profile Access UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let profileAccessInMemory: InMemoryProfileAccessRepository;
  let notificationService: NotificationService;

  let updateProfileAccess: UpdateProfileAccessUseCase;

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

    updateProfileAccess = new UpdateProfileAccessUseCase(
      userInMemory,
      profileAccessInMemory,
      businessInMemory,
      notificationService,
    );
  });

  it("should be able to update a profile access", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    const updatedProfileAccess = await updateProfileAccess.execute(
      {
        businessId: createdProfileAccess.businessId as string,
        name: "Updated Profile",
        profileAccessId: createdProfileAccess.id,
      },
      createdUser.id,
    );

    expect(updatedProfileAccess).toHaveProperty("id");
    expect(updatedProfileAccess.name).toBe("Updated Profile");
    expect(updatedProfileAccess.businessId).toBe(createdBusiness.id);

    // Verify that notification service was called
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Perfil de acesso",
      action: "update",
      entityId: updatedProfileAccess.id,
      description: expect.stringContaining(
        `Perfil de acesso atualizado com sucesso: Updated Profile`,
      ),
      status: "Atualizado",
      performedBy: createdUser.id,
      businessId: createdBusiness.id,
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      updateProfileAccess.execute(
        {
          businessId: "non-business-id",
          name: "non-profile-access-name",
          profileAccessId: "non-profile-access-id",
        },
        "non-user-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ProfileAccessNotFoundError if profile does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(
      updateProfileAccess.execute(
        {
          businessId: "non-business-id",
          name: "non-profile-access-name",
          profileAccessId: "non-profile-access-id",
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        businessId: "existing-business-id",
        name: "Existing Profile Access",
      });

    await expect(
      updateProfileAccess.execute(
        {
          businessId: "non-existing-business-id",
          name: "Updated Profile",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw ProfileAccessCannotBeUpdatedByHimselfError if the user tries to update their own profile access", async () => {
    const createdProfileAccess =
      await profileAccessInMemory.createProfileAccess({
        name: "Existing Profile",
        businessId: "some-business-id",
      });

    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: createdProfileAccess.id,
      role: "MASTER",
    });

    await expect(
      updateProfileAccess.execute(
        {
          businessId: "some-business-id",
          name: "Updated Profile",
          profileAccessId: createdUser.profileAccessId as string,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessCannotBeUpdatedByHimselfError);
  });

  it("should throw ProfileAccessAlreadyExistsError if profile access with the same name already exists", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    await profileAccessInMemory.createProfileAccess({
      businessId: createdBusiness.id as string,
      name: "Test Profile Access",
    });

    const profileToUpdate = await profileAccessInMemory.createProfileAccess({
      businessId: createdBusiness.id as string,
      name: "Another Profile",
    });

    await expect(
      updateProfileAccess.execute(
        {
          businessId: createdBusiness.id as string,
          name: "Test Profile Access",
          profileAccessId: profileToUpdate.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessAlreadyExistsError);
  });

  it("should throw AppError if create profile operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

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

    // 🛠 Simulates a failure in creating the access profile
    vi.spyOn(
      profileAccessInMemory,
      "updateProfileAccess",
    ).mockImplementationOnce(async () => {
      throw new Error("Simulated create failure");
    });

    await expect(
      updateProfileAccess.execute(
        {
          businessId: createdProfileAccess.businessId as string,
          name: "New Profile Access",
          profileAccessId: createdProfileAccess.id,
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
