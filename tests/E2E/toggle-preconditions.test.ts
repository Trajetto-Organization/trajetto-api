import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { BranchRepository } from "@/modules/branch/repositories/branch-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

/**
 * Two people flipping the same switch, and only one flip happening.
 *
 * A toggle that reads the current value, negates it and writes is a lost
 * update with a friendly face: both requests read `true`, both write `false`,
 * and two deliberate actions produce one change while each caller believes
 * they caused it. Nobody sees an error, so nobody looks.
 *
 * Deactivating a company also disconnects every session it has, and revoking
 * access pushes a security event down the socket — so the duplicate is not
 * just a wasted write, it is a broadcast for a change that did not happen.
 *
 * A SEPARATE `PrismaClient` per attempt, for the reason spelled out in
 * `write-preconditions.test.ts`: one client funnels everything through one
 * connection and serialises the race by accident.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe000-0000-7000-8000-0000000000d1";
const STAFF = "018fe000-0000-7000-8000-0000000000d2";

let branchId = "";
let profileAccessId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Interruptores",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10222888000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `toggle-${randomUUID()}@exemplo.com.br`,
      is_active: true,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `1022288800${Math.floor(Math.random() * 9000 + 1000)}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
      is_active: true,
    },
  });

  branchId = branch.id;

  const profile = await prisma.profileAccess.create({
    data: { name: `Perfil ${randomUUID().slice(0, 8)}`, businessId: CARRIER },
  });

  profileAccessId = profile.id;

  await prisma.user.create({
    data: {
      id: STAFF,
      name: "Operador",
      email: `operador-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: profile.id,
      access_revoked: false,
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: STAFF } });
  await prisma.profileAccess.deleteMany({ where: { id: profileAccessId } });
  await prisma.branch.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

/** One client per attempt: anything less serialises the race away. */
function racers(count: number): PrismaClient[] {
  return Array.from({ length: count }, () => new PrismaClient());
}

async function release(clients: PrismaClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.$disconnect()));
}

describe("deactivating a company", () => {
  it("lets exactly one of six simultaneous flips through", async () => {
    await prisma.business.update({
      where: { id: CARRIER },
      data: { is_active: true },
    });

    const clients = racers(6);

    const results = await Promise.all(
      clients.map((client) =>
        new BusinessRepository(client)
          .toggleBusinessActive(CARRIER, true)
          .catch(() => null),
      ),
    );

    await release(clients);

    expect(results.filter(Boolean)).toHaveLength(1);

    const settled = await prisma.business.findUnique({
      where: { id: CARRIER },
    });

    expect(settled?.is_active).toBe(false);
  });

  it("refuses a flip whose expected value is already stale", async () => {
    await prisma.business.update({
      where: { id: CARRIER },
      data: { is_active: false },
    });

    // Somebody else got there first, so this caller's idea of the state is a
    // screen that has not been refreshed.
    expect(
      await new BusinessRepository(prisma).toggleBusinessActive(CARRIER, true),
    ).toBeNull();
  });
});

describe("deactivating a branch", () => {
  it("lets exactly one of six simultaneous flips through", async () => {
    await prisma.branch.update({
      where: { id: branchId },
      data: { is_active: true },
    });

    const clients = racers(6);

    const results = await Promise.all(
      clients.map((client) =>
        new BranchRepository(client)
          .toggleBranchActive(branchId, true)
          .catch(() => null),
      ),
    );

    await release(clients);

    expect(results.filter(Boolean)).toHaveLength(1);

    expect(
      (await prisma.branch.findUnique({ where: { id: branchId } }))?.is_active,
    ).toBe(false);
  });
});

describe("revoking a user's access", () => {
  it("lets exactly one of six simultaneous flips through", async () => {
    await prisma.user.update({
      where: { id: STAFF },
      data: { access_revoked: false },
    });

    const clients = racers(6);

    const results = await Promise.all(
      clients.map((client) =>
        new UserRepository(client)
          .toggleUserAccessRevocation(STAFF, false)
          .catch(() => false),
      ),
    );

    await release(clients);

    // The one that matters: five of these would otherwise have pushed
    // "access_revoked" down the socket for a change they did not make.
    expect(results.filter(Boolean)).toHaveLength(1);

    expect(
      (await prisma.user.findUnique({ where: { id: STAFF } }))?.access_revoked,
    ).toBe(true);
  });

  it("refuses to revoke again once it is already revoked", async () => {
    expect(
      await new UserRepository(prisma).toggleUserAccessRevocation(STAFF, false),
    ).toBe(false);
  });

  it("restores when the expected state matches", async () => {
    expect(
      await new UserRepository(prisma).toggleUserAccessRevocation(STAFF, true),
    ).toBe(true);

    expect(
      (await prisma.user.findUnique({ where: { id: STAFF } }))?.access_revoked,
    ).toBe(false);
  });

  it("does not resurrect a user that is not there", async () => {
    expect(
      await new UserRepository(prisma).toggleUserAccessRevocation(
        randomUUID(),
        false,
      ),
    ).toBe(false);
  });
});
