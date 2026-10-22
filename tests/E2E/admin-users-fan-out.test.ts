import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How many pool connections the user, profile and permission lists take at
 * once (tests/E2E/connection-fan-out.test.ts explains the budget: two).
 *
 * Each reads a page and one GROUP BY (or a count) side by side, then the
 * extras one at a time — never three queries in parallel, whatever the
 * filters. Measured by wrapping the application's own client, so the
 * repositories run exactly the code production runs.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));

vi.mock("@/../infra/database", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");

  const counted = new Client().$extends({
    query: {
      async $allOperations({ args, query }) {
        pool.inFlight += 1;
        pool.peak = Math.max(pool.peak, pool.inFlight);

        try {
          return await query(args);
        } finally {
          pool.inFlight -= 1;
        }
      },
    },
  });

  return { default: counted };
});

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ProfileAccessRepository } from "@/modules/profile-access/repositories/profile-access-repository";
import { PermissionRepository } from "@/modules/permission/repositories/permission-repository";

const prisma = new PrismaClient();

const CARRIER = randomUUID();
const BUDGET = 2;

let PROFILE = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pool de Usuários",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(55000000000100 + Math.floor(Math.random() * 1_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-${randomUUID()}@exemplo.com.br`,
    },
  });

  PROFILE = (
    await prisma.profileAccess.create({
      data: { name: "Operação", businessId: CARRIER },
    })
  ).id;

  await prisma.permission.create({
    data: {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      canWrite: false,
      businessId: CARRIER,
      profileAccessId: PROFILE,
    },
  });

  for (let index = 0; index < 3; index += 1) {
    await prisma.user.create({
      data: {
        name: `Pessoa Pool ${index}`,
        email: `pool-${randomUUID()}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: PROFILE,
        email_verified: index === 0 ? new Date() : null,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();
});

function reset() {
  pool.inFlight = 0;
  pool.peak = 0;
}

describe("the admin-users lists' connection budget", () => {
  it("the user list, with search, every facet and a sort", async () => {
    reset();

    const result = await new UserRepository().listUsers({
      page: 1,
      pageSize: 10,
      businessId: CARRIER,
      currentUserId: randomUUID(),
      currentUserRole: "BUSINESS_ADMIN",
      search: "Pool",
      sort: "profileAccess",
      order: "asc",
      roles: ["BUSINESS_USER"],
      access: ["active"],
      twoFactor: ["disabled"],
      profileAccessIds: [PROFILE],
    });

    expect(result.data).toHaveLength(3);
    expect(result.emailVerified).toBe(1);
    expect(pool.peak).toBeGreaterThanOrEqual(1);
    expect(pool.peak).toBeLessThanOrEqual(BUDGET);
  });

  it("the profile list", async () => {
    reset();

    const result = await new ProfileAccessRepository().listProfileAccess({
      page: 1,
      pageSize: 10,
      businessId: CARRIER,
      search: "Opera",
      sort: "usersCount",
      order: "desc",
    });

    expect(result.data[0]).toMatchObject({
      usersCount: 3,
      permissionsCount: 1,
    });
    expect(pool.peak).toBeLessThanOrEqual(BUDGET);
  });

  it("the permission list", async () => {
    reset();

    const result = await new PermissionRepository().listPermission({
      page: 1,
      pageSize: 10,
      businessId: CARRIER,
      search: "kanban",
      sort: "profile_name",
      permissionKeys: ["kanban_manage"],
      profileAccessIds: [PROFILE],
      read: ["enabled"],
      write: ["disabled"],
    });

    expect(result.data).toHaveLength(1);
    expect(pool.peak).toBeLessThanOrEqual(BUDGET);
  });
});
