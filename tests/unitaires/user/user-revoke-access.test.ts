import { describe, it, expect, beforeEach, vi } from "vitest";

import { UserRevokeAccessUseCase } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserCannotBeRevokeByHimselfError } from "@/modules/user/usecases/errors/user-cannot-be-revoke-access-by-himself-error";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { AppError } from "@/shared/errors/AppError";

describe("User Revoke Access UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let userRevokeAccessUseCase: UserRevokeAccessUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    userRevokeAccessUseCase = new UserRevokeAccessUseCase(userInMemory);
  });

  it("should be able to revoke access for a user", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await userRevokeAccessUseCase.execute({
      userId: businessUser.id,
      id: masterUser.id,
    });

    const updatedUser = await userInMemory.findUserById(businessUser.id);
    expect(updatedUser?.access_revoked).toBe(true);
  });

  it("should be able to restore access for a revoked user", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    // First revoke access
    await userRevokeAccessUseCase.execute({
      userId: businessUser.id,
      id: masterUser.id,
    });

    // Verify access is revoked
    let updatedUser = await userInMemory.findUserById(businessUser.id);
    expect(updatedUser?.access_revoked).toBe(true);

    // Now restore access
    await userRevokeAccessUseCase.execute({
      userId: businessUser.id,
      id: masterUser.id,
    });

    // Verify access is restored
    updatedUser = await userInMemory.findUserById(businessUser.id);
    expect(updatedUser?.access_revoked).toBe(false);
  });

  it("should throw ResourceNotFoundError if the requesting user is not found", async () => {
    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await expect(
      userRevokeAccessUseCase.execute({
        userId: businessUser.id,
        id: "non-existent-user-id",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw ResourceNotFoundError if the target user is not found", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await expect(
      userRevokeAccessUseCase.execute({
        userId: "non-existent-user-id",
        id: masterUser.id,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw UserCannotBeRevokeByHimselfError if user tries to revoke his own access", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await expect(
      userRevokeAccessUseCase.execute({
        userId: masterUser.id,
        id: masterUser.id,
      }),
    ).rejects.toBeInstanceOf(UserCannotBeRevokeByHimselfError);
  });

  it("should throw AppError if user role does not allow revoking target user role", async () => {
    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await expect(
      userRevokeAccessUseCase.execute({
        userId: masterUser.id,
        id: businessUser.id,
      }),
    ).rejects.toEqual(
      new AppError(
        'Usuários com o nível de acesso "Usuário" não podem deletar usuários com o nível de acesso Master.',
        403,
      ),
    );
  });

  it("should allow BUSINESS_ADMIN to revoke BUSINESS_USER access", async () => {
    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashedpassword",
      name: "Admin User",
      role: "BUSINESS_ADMIN",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await userRevokeAccessUseCase.execute({
      userId: businessUser.id,
      id: adminUser.id,
    });

    const updatedUser = await userInMemory.findUserById(businessUser.id);
    expect(updatedUser?.access_revoked).toBe(true);
  });

  it("should allow MASTER to revoke any user access", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const adminUser = await userInMemory.createUser({
      email: "admin@example.com",
      password: "hashedpassword",
      name: "Admin User",
      role: "BUSINESS_ADMIN",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    await userRevokeAccessUseCase.execute({
      userId: adminUser.id,
      id: masterUser.id,
    });

    const updatedUser = await userInMemory.findUserById(adminUser.id);
    expect(updatedUser?.access_revoked).toBe(true);
  });

  it("should throw AppError if an error occurs during revocation process", async () => {
    const masterUser = await userInMemory.createUser({
      email: "master@example.com",
      password: "hashedpassword",
      name: "Master User",
      role: "MASTER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    const businessUser = await userInMemory.createUser({
      email: "user@example.com",
      password: "hashedpassword",
      name: "Business User",
      role: "BUSINESS_USER",
      businessId: "business-id",
      profileAccessId: "profile-id",
    });

    vi.spyOn(userInMemory, "updateUserAccessRevocation").mockImplementationOnce(
      async () => {
        throw new Error("Database error");
      },
    );

    await expect(
      userRevokeAccessUseCase.execute({
        userId: businessUser.id,
        id: masterUser.id,
      }),
    ).rejects.toEqual(
      new AppError(
        "Não foi possível revogar o acesso deste usuário! Por favor, Tente novamente.",
        500,
      ),
    );
  });
});
