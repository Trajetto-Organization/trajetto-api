import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { DeleteBusinessUseCase } from "@/modules/business/usecases/delete-business/delete-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let businessInMemory: InMemoryBusinessRepository;

let notificationService: NotificationService;
let deleteBusiness: DeleteBusinessUseCase;

describe("Delete Business UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    businessInMemory = new InMemoryBusinessRepository();

    notificationService = {
      createActivityIfEnabled: vi.fn(),
      createNotificationIfEnabled: vi.fn(),
      processUserNotifications: vi.fn(),
    } as any;

    deleteBusiness = new DeleteBusinessUseCase(
      userInMemory,
      businessInMemory,
      notificationService,
    );
  });

  it("should be able to delete a business", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
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
    });

    const deletedBusiness = await deleteBusiness.execute(
      createdBusiness.id as string,
      createdUser.id,
    );

    expect(deletedBusiness.id).toEqual(createdBusiness.id);

    const findDeleted = await businessInMemory.findBusinessById(
      createdBusiness.id as string,
    );

    expect(findDeleted).toBeNull();
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
    });

    await expect(
      deleteBusiness.execute(
        createdBusiness.id as string,
        "non-existing-user-id",
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw BusinessNotFoundError if business does not exist", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
      role: "MASTER",
    });

    await expect(
      deleteBusiness.execute("non-existing-business-id", createdUser.id),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
  });

  it("should throw AppError if delete operation fails", async () => {
    const createdUser = await userInMemory.createUser({
      email: "test@example.com",
      password: "password",
      name: "Test User",
      businessId: "business@example",
      profileAccessId: "profile@example",
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
    });

    vi.spyOn(businessInMemory, "deleteBusiness").mockImplementationOnce(
      async () => {
        throw new Error("Simulated delete failure");
      },
    );

    await expect(
      deleteBusiness.execute(createdBusiness.id as string, createdUser.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
