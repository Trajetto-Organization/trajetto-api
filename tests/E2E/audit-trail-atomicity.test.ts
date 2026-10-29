import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import database from "@/../infra/database";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { ProfileAccessRepository } from "@/modules/profile-access/repositories/profile-access-repository";
import { PermissionRepository } from "@/modules/permission/repositories/permission-repository";
import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";

import { DeleteProfileAccessUseCase } from "@/modules/profile-access/usecases/delete-profile-access/delete-profile-access-usecase";
import { BulkConfigurePermissionsUseCase } from "@/modules/permission/usecases/bulk-configure-permissions/bulk-configure-permissions-usecase";
import { ToggleBusinessActiveUseCase } from "@/modules/business/usecases/toggle-business-active/toggle-business-active-usecase";
import { DeleteMasterUserUseCase } from "@/modules/user/usecases/delete-master-user/delete-master-user-usecase";

import { NotificationService } from "@/shared/services/notification-service";
import { logger } from "@/shared/logging/logger";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The audit trail of the sensitive actions (GAP2-4, OUTBOX-10).
 *
 * The entry used to be published to the outbox AFTER the action committed,
 * fire-and-forget, with any failure reduced to a console.warn. Revoking a
 * permission, deleting a profile, deactivating a company or removing a MASTER
 * could therefore happen with no trace at all — exactly the actions an
 * auditor looks for first.
 *
 * Now the entry is written straight to the activity table and, on these
 * sites, inside the action's own transaction: both land or neither does.
 * Simulated by making the activity insert fail, the way a statement refused
 * at that exact point would.
 */
vi.mock("@/websocket", () => ({
  sendEntitlementsChangedEvent: vi.fn(),
  sendSecurityEventToBusiness: vi.fn(),
  sendSecurityEventToUser: vi.fn(),
  // Catalogue writes (access profiles, driver logins) hint the open tabs
  // after the commit (decision 2.3).
  sendCatalogChangedEvent: vi.fn(),
}));

const prisma = createPrismaClient();

const MASTER = "018fdc20-0000-7000-8000-0000000000a1";
const OTHER_MASTER = "018fdc20-0000-7000-8000-0000000000a2";
const ADMIN = "018fdc20-0000-7000-8000-0000000000b1";

let carrier = "";

const activities = new ActivityRepository();

function notifications() {
  return new NotificationService(activities);
}

function refuseActivityInsert() {
  return vi
    .spyOn(activities, "createActivity")
    .mockRejectedValue(new Error("activity insert refused"));
}

async function seedProfile(name: string): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: { name: `${name} ${randomUUID().slice(0, 8)}`, businessId: carrier },
  });

  return profile.id;
}

beforeAll(async () => {
  const business = await prisma.business.create({
    data: {
      corporate_reason: "Transportadora da Trilha",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "62555111000190",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `trilha-${randomUUID()}@exemplo.com.br`,
    },
  });

  carrier = business.id;

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        name: "Master da Trilha",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: OTHER_MASTER,
        name: "Outro Master",
        email: `outro-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: ADMIN,
        name: "Administradora da Trilha",
        email: `admin-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: carrier,
      },
    ],
  });
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an audit entry recorded without a transaction", () => {
  it("is in the activity table when the call returns, with no outbox event behind it", async () => {
    const entityId = randomUUID();

    await notifications().createActivityIfEnabled({
      type: "Fornecedor",
      action: "create",
      entityId,
      description: "Fornecedor criado",
      status: "Criado",
      performedBy: ADMIN,
      businessId: carrier,
    });

    const rows = await prisma.activity.findMany({ where: { entityId } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      performedBy: ADMIN,
      businessId: carrier,
      tenantName: "Transportadora da Trilha",
    });

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "activity.recorded", aggregateId: entityId },
      }),
    ).toBe(0);
  });

  it("never fails the caller when the table refuses it", async () => {
    refuseActivityInsert();
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(
      notifications().createActivityIfEnabled({
        type: "Fornecedor",
        action: "create",
        entityId: randomUUID(),
        description: "Fornecedor criado",
        status: "Criado",
        performedBy: ADMIN,
        businessId: carrier,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("an audit entry recorded inside the caller's transaction", () => {
  it("disappears with it when the transaction rolls back", async () => {
    const entityId = randomUUID();

    await expect(
      database.$transaction(async (tx) => {
        await notifications().createActivityIfEnabled(
          {
            type: "Fornecedor",
            action: "create",
            entityId,
            description: "Fornecedor criado",
            status: "Criado",
            performedBy: ADMIN,
            businessId: carrier,
          },
          tx,
        );

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await prisma.activity.count({ where: { entityId } })).toBe(0);
  });
});

describe("deleting an access profile", () => {
  const useCase = () =>
    new DeleteProfileAccessUseCase(
      new UserRepository(),
      new ProfileAccessRepository(),
      notifications(),
    );

  it("does not happen unaudited: a refused entry keeps the profile", async () => {
    const profileId = await seedProfile("Conferente");

    refuseActivityInsert();

    await expect(useCase().execute(profileId, ADMIN)).rejects.toBeDefined();

    expect(
      await prisma.profileAccess.findUnique({ where: { id: profileId } }),
    ).not.toBeNull();
  });

  it("commits the deletion and its entry together", async () => {
    const profileId = await seedProfile("Expedição");

    await useCase().execute(profileId, ADMIN);

    expect(
      await prisma.profileAccess.findUnique({ where: { id: profileId } }),
    ).toBeNull();

    expect(
      await prisma.activity.count({
        where: { entityId: profileId, action: "delete", performedBy: ADMIN },
      }),
    ).toBe(1);
  });
});

describe("reconfiguring a profile's permissions in bulk", () => {
  it("keeps the old permissions when the entry is refused", async () => {
    const profileId = await seedProfile("Financeiro");

    await prisma.permission.create({
      data: {
        action: "Gerenciar multas",
        permissionKey: "fine_manage",
        canRead: true,
        canWrite: true,
        profileAccessId: profileId,
        businessId: carrier,
      },
    });

    refuseActivityInsert();

    await expect(
      new BulkConfigurePermissionsUseCase(
        new UserRepository(),
        new PermissionRepository(),
        new BusinessRepository(),
        new ProfileAccessRepository(),
        notifications(),
      ).execute(
        { businessId: carrier, profileAccessId: profileId, permissions: [] },
        ADMIN,
      ),
    ).rejects.toBeDefined();

    expect(
      await prisma.permission.count({ where: { profileAccessId: profileId } }),
    ).toBe(1);
  });
});

describe("deactivating a company", () => {
  it("does not happen unaudited", async () => {
    refuseActivityInsert();

    await expect(
      new ToggleBusinessActiveUseCase(
        new UserRepository(),
        new BusinessRepository(),
        notifications(),
      ).execute(carrier, MASTER),
    ).rejects.toBeDefined();

    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: carrier } }))
        .is_active,
    ).toBe(true);
  });
});

describe("removing a MASTER", () => {
  it("does not happen unaudited", async () => {
    refuseActivityInsert();

    await expect(
      new DeleteMasterUserUseCase(
        new UserRepository(),
        new ServiceOrderRepository(),
        new AccountPayableRepository(),
        notifications(),
      ).execute({ masterUserId: OTHER_MASTER, performedById: MASTER }),
    ).rejects.toBeDefined();

    expect(
      await prisma.user.findUnique({ where: { id: OTHER_MASTER } }),
    ).not.toBeNull();
  });
});
