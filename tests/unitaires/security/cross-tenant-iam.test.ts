import { describe, expect, it, vi } from "vitest";

import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { DeleteUserUseCase } from "@/modules/user/usecases/delete-user/delete-user-usecase";
import { DeleteProfileAccessUseCase } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-usecase";
import { DeletePermissionUseCase } from "@/modules/permission/usecases/delete-permission/delete-permission-usecase";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { ProfileAccess } from "@/modules/profile-access/dtos/profile-access-dto";
import type { Permission } from "@/modules/permission/dtos/permission-dto";

// The three IAM routes carry no :businessId, so the request hook has nothing
// to compare and the whole isolation rests on the use case.
vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: () => {},
  sendSecurityEventToBusiness: () => {},
  sendCatalogChangedEvent: () => {},
}));

// The deletes write their audit line in the same transaction. A unit run has
// no database, so the real $transaction failed and the admin's own delete
// came back as the use case's 500 instead of the deletion.
vi.mock("@/../infra/database", () => ({
  default: { $transaction: (run: (client: unknown) => Promise<unknown>) => run({}) },
}));

const BUSINESS_A = "018f0000-0000-7000-8000-00000000000a";
const BUSINESS_B = "018f0000-0000-7000-8000-00000000000b";

const ATTACKER = "018f0000-0000-7000-8000-0000000000a1";
const VICTIM = "018f0000-0000-7000-8000-0000000000b1";

const PROFILE_OF_B = "018f0000-0000-7000-8000-0000000000f1";
const PERMISSION_OF_B = "018f0000-0000-7000-8000-0000000000e1";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

/**
 * Another company's record answers exactly like a missing one: a 403 next to
 * a 404 told the attacker which ids exist elsewhere (IDOR sweep, 10/2026).
 */
const notFoundError = () => new AppError("Não encontrado.", 404, "RECORD_NOT_FOUND");

const notFound = expect.objectContaining({ statusCode: 404 });

function seedUsers() {
  const userRepository = new InMemoryUserRepository();

  userRepository.user.push({
    id: ATTACKER,
    name: "Admin da Transportadora A",
    email: "admin@a.com",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS_A,
  } as User);

  userRepository.user.push({
    id: VICTIM,
    name: "Admin da Transportadora B",
    email: "admin@b.com",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS_B,
  } as User);

  return userRepository;
}

describe("assertTenantAccessToRecord", () => {
  it("denies a record that belongs to another tenant", () => {
    expect(() =>
      assertTenantAccessToRecord(
        { role: "BUSINESS_ADMIN", businessId: BUSINESS_A },
        BUSINESS_B,
        notFoundError,
      ),
    ).toThrowError(expect.objectContaining({ statusCode: 404, code: "RECORD_NOT_FOUND" }));
  });

  it("allows a record of the caller's own tenant", () => {
    expect(() =>
      assertTenantAccessToRecord(
        { role: "BUSINESS_ADMIN", businessId: BUSINESS_A },
        BUSINESS_A,
        notFoundError,
      ),
    ).not.toThrow();
  });

  it("denies a tenantless record to anyone but a master", () => {
    // A null businessId is a MASTER user; a company admin must not reach it.
    expect(() =>
      assertTenantAccessToRecord(
        { role: "BUSINESS_ADMIN", businessId: BUSINESS_A },
        null,
        notFoundError,
      ),
    ).toThrowError(notFound);

    expect(() =>
      assertTenantAccessToRecord({ role: "MASTER", businessId: null }, null, notFoundError),
    ).not.toThrow();
  });

  it("lets a master cross tenants, as every other guard does", () => {
    expect(() =>
      assertTenantAccessToRecord({ role: "MASTER", businessId: null }, BUSINESS_B, notFoundError),
    ).not.toThrow();
  });
});

describe("IAM routes without :businessId refuse another tenant's record", () => {
  it("delete-user: an admin of A cannot delete a user of B", async () => {
    const userRepository = seedUsers();

    const useCase = new DeleteUserUseCase(
      userRepository,
      new InMemoryServiceOrderRepository(),
      new InMemoryAccountPayableRepository(),
      notificationStub,
    );

    await expect(
      useCase.execute({ userId: VICTIM, id: ATTACKER }),
    ).rejects.toThrowError(expect.objectContaining({ statusCode: 404, code: "USER_NOT_FOUND" }));

    // The refusal has to happen before the write, not after it.
    expect(userRepository.user.some((user) => user.id === VICTIM)).toBe(true);
  });

  it("delete-profile-access: an admin of A cannot delete a profile of B", async () => {
    const userRepository = seedUsers();
    const profileRepository = new InMemoryProfileAccessRepository();

    profileRepository.profileAccess.push({
      id: PROFILE_OF_B,
      name: "Operação",
      businessId: BUSINESS_B,
    } as ProfileAccess);

    const useCase = new DeleteProfileAccessUseCase(
      userRepository,
      profileRepository,
      notificationStub,
    );

    await expect(
      useCase.execute(PROFILE_OF_B, ATTACKER),
    ).rejects.toThrowError(
      expect.objectContaining({ statusCode: 404, code: "PROFILE_ACCESS_NOT_FOUND" }),
    );

    expect(profileRepository.profileAccess).toHaveLength(1);
  });

  it("delete-permission: an admin of A cannot delete a permission of B", async () => {
    const userRepository = seedUsers();
    const permissionRepository = new InMemoryPermissionRepository();

    permissionRepository.permissions.push({
      id: PERMISSION_OF_B,
      action: "delivery_manage",
      businessId: BUSINESS_B,
      profileAccessId: PROFILE_OF_B,
    } as Permission);

    const useCase = new DeletePermissionUseCase(
      userRepository,
      permissionRepository,
      notificationStub,
    );

    await expect(
      useCase.execute(PERMISSION_OF_B, ATTACKER),
    ).rejects.toThrowError(expect.objectContaining({ statusCode: 404, code: "PERMISSION_NOT_FOUND" }));

    expect(permissionRepository.permissions).toHaveLength(1);
  });

  it("still lets an admin act inside their own company", async () => {
    const userRepository = seedUsers();
    const profileRepository = new InMemoryProfileAccessRepository();

    profileRepository.profileAccess.push({
      id: PROFILE_OF_B,
      name: "Operação",
      businessId: BUSINESS_A,
    } as ProfileAccess);

    const useCase = new DeleteProfileAccessUseCase(
      userRepository,
      profileRepository,
      notificationStub,
    );

    await expect(
      useCase.execute(PROFILE_OF_B, ATTACKER),
    ).resolves.toMatchObject({ id: PROFILE_OF_B });
  });
});
