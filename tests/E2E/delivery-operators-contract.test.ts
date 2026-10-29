import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { UserRole } from "@/modules/user/dtos/user-dto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * findDeliveryOperators (DLVP-NOTIF-1), the same people in Postgres and in
 * the in-memory twin (decision 13.2): who runs the company's deliveries is
 * its administrators plus the BUSINESS_USERs whose profile writes
 * delivery_manage — never a driver, a revoked account, a reader or another
 * company. Oldest first, ties by id.
 */
const prisma = createPrismaClient();

const A = randomUUID();
const B = randomUUID();

const memory = new InMemoryUserRepository();

let WRITES = "";
let READS = "";
let FLEET = "";
let DRIVER = "";

let cnpj = 71000000000100 + Math.floor(Math.random() * 1_000_000);

const people: Array<{
  key: string;
  role: UserRole;
  business: "A" | "B";
  profile?: "writes" | "reads" | "fleet";
  driver?: boolean;
  revoked?: boolean;
  minutes: number;
}> = [
  { key: "admin", role: "BUSINESS_ADMIN", business: "A", minutes: 1 },
  {
    key: "operator",
    role: "BUSINESS_USER",
    business: "A",
    profile: "writes",
    minutes: 2,
  },
  {
    key: "reader",
    role: "BUSINESS_USER",
    business: "A",
    profile: "reads",
    minutes: 3,
  },
  {
    key: "fleet",
    role: "BUSINESS_USER",
    business: "A",
    profile: "fleet",
    minutes: 4,
  },
  {
    key: "revoked",
    role: "BUSINESS_USER",
    business: "A",
    profile: "writes",
    revoked: true,
    minutes: 5,
  },
  {
    key: "driver",
    role: "BUSINESS_USER",
    business: "A",
    profile: "writes",
    driver: true,
    minutes: 6,
  },
  { key: "no-profile", role: "BUSINESS_USER", business: "A", minutes: 7 },
  {
    key: "tie-1",
    role: "BUSINESS_USER",
    business: "A",
    profile: "writes",
    minutes: 8,
  },
  {
    key: "tie-2",
    role: "BUSINESS_USER",
    business: "A",
    profile: "writes",
    minutes: 8,
  },
  { key: "other-admin", role: "BUSINESS_ADMIN", business: "B", minutes: 9 },
];

const harnesses: Array<{
  name: string;
  repo: IUserRepository;
  ids: Map<string, string>;
}> = [
  { name: "prisma", repo: new UserRepository(prisma as never), ids: new Map() },
  { name: "in-memory", repo: memory, ids: new Map() },
];

async function seedBusiness(id: string): Promise<void> {
  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(cnpj),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function profile(
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const created = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId: A,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId: A,
          },
        ],
      },
    },
    include: { permissions: true },
  });

  memory.profilePermissions.set(
    created.id,
    created.permissions.map((permission) => ({
      id: permission.id,
      permissionKey: permission.permissionKey,
      action: permission.action,
      canRead: permission.canRead,
      canWrite: permission.canWrite,
    })),
  );
  memory.profiles.set(created.id, { name: created.name, businessId: A });

  return created.id;
}

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  WRITES = await profile("delivery_manage", true);
  READS = await profile("delivery_manage", false);
  FLEET = await profile("vehicle_manage", true);

  DRIVER = (
    await prisma.driver.create({
      data: {
        name: "Motorista",
        birth_date: new Date("1990-01-01"),
        cnh: `cnh-${randomUUID().slice(0, 8)}`,
        cpf: `cpf-${randomUUID().slice(0, 8)}`,
        rg: "123",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: A,
      },
    })
  ).id;

  const profiles = { writes: WRITES, reads: READS, fleet: FLEET };

  for (const harness of harnesses) {
    for (const person of people) {
      const created = await harness.repo.createUser({
        email: `${person.key}.${randomUUID()}@exemplo.com.br`,
        name: person.key,
        password: "hash",
        role: person.role,
        businessId: person.business === "A" ? A : B,
        profileAccessId: person.profile ? profiles[person.profile] : null,
        driverId: person.driver ? DRIVER : null,
      });

      harness.ids.set(person.key, created.id);

      const fields = {
        created_at: new Date(Date.UTC(2026, 0, 1, 12, person.minutes)),
        access_revoked: person.revoked ?? false,
      };

      if (harness.name === "prisma") {
        await prisma.user.update({ where: { id: created.id }, data: fields });
      } else {
        Object.assign(
          memory.user.find((user) => user.id === created.id)!,
          fields,
        );
      }
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: Array.from(harnesses[0].ids.values()) } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

describe.each(harnesses.map((harness) => [harness.name, harness] as const))(
  "%s user repository",
  (_name, harness) => {
    it("finds the company's delivery operators and nobody else", async () => {
      const operators = await harness.repo.findDeliveryOperators(A);

      const keyOf = (id: string) =>
        [...harness.ids.entries()].find(([, value]) => value === id)?.[0];

      const keys = operators.map((user) => keyOf(user.id));

      // The two ties come back in id order in both stores.
      const ties = ["tie-1", "tie-2"].sort((left, right) =>
        harness.ids.get(left)! < harness.ids.get(right)! ? -1 : 1,
      );

      expect(keys).toEqual(["admin", "operator", ...ties]);
    });

    it("answers another company with its own people", async () => {
      const operators = await harness.repo.findDeliveryOperators(B);

      expect(operators.map((user) => user.id)).toEqual([
        harness.ids.get("other-admin"),
      ]);
    });
  },
);
