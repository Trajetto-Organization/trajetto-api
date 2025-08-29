import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";

import { CreateProfileAccessUseCase } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-usecase";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ProfileAccessAlreadyExistsError } from "@/modules/profile-access/usecases/errors/profile-access-already-exists-error";
import { AppError } from "@/shared/errors/AppError";

describe("Create Profile Access UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let businessInMemory: InMemoryBusinessRepository;

  let profileAccessInMemory: InMemoryProfileAccessRepository;
  let notificationService: NotificationService;

  let profileAccess: CreateProfileAccessUseCase;

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

    profileAccess = new CreateProfileAccessUseCase(
      userInMemory,
      profileAccessInMemory,
      businessInMemory,
      notificationService,
    );
  });

  it("should be able to create a profile access", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
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
    };

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    const createdProfileAccess = await profileAccess.execute(
      {
        businessId: createdBusiness.id as string,
        name: "New Profile Access",
      },
      createdUser.id,
    );

    // ✅ Checks whether the access profile was created correctly
    expect(createdProfileAccess).toHaveProperty("id");
    expect(createdProfileAccess.name).toBe("New Profile Access");

    expect(createdProfileAccess.businessId).toBe(createdBusiness.id);

    // ✅ Checks whether the access profile has been saved in the in-memory repository
    const foundProfile = await profileAccessInMemory.findProfileAccessById(
      createdProfileAccess.id,
    );

    expect(foundProfile).not.toBeNull();
    expect(foundProfile?.name).toBe("New Profile Access");

    expect(foundProfile?.businessId).toBe(createdBusiness.id);

    // Verify that notification service was called
    expect(notificationService.createActivityIfEnabled).toHaveBeenCalledWith({
      type: "Perfil de acesso",
      action: "create",
      entityId: createdProfileAccess.id,
      description: expect.stringContaining(
        `Perfil de acesso criado com sucesso: New Profile Access`,
      ),
      status: "Completo",
      performedBy: createdUser.id,
      businessId: createdBusiness.id,
    });
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      profileAccess.execute(
        {
          businessId: "non-business-id",
          name: "non-profile-access-name",
        },
        "non-user-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
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

    await expect(
      profileAccess.execute(
        {
          businessId: "non-business-id",
          name: "New Profile Access",
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw ProfileAccessAlreadyExistsError if profile access already exists with the same name and businessId", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const businessData = {
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
    };

    const createdBusiness = await businessInMemory.createBusiness(businessData);

    // ✅ Creating the first access profile with the same name and businessId
    await profileAccess.execute(
      {
        businessId: createdBusiness.id as string,
        name: "Existing Profile",
      },
      createdUser.id,
    );

    // ❌ Trying to create another access profile with the same name and businessId
    await expect(
      profileAccess.execute(
        {
          businessId: createdBusiness.id as string,
          name: "Existing Profile", // Same name as the profile already created
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(ProfileAccessAlreadyExistsError);
  });

  it("should throw AppError if create operation fails", async () => {
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

    // 🛠 Simulates a failure in creating the access profile
    vi.spyOn(
      profileAccessInMemory,
      "createProfileAccess",
    ).mockImplementationOnce(async () => {
      throw new Error("Simulated create failure");
    });

    await expect(
      profileAccess.execute(
        {
          businessId: createdBusiness.id as string,
          name: "New Profile Access",
        },
        createdUser.id,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
