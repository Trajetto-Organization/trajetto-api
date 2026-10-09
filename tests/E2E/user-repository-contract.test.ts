import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";
import type { UserRole } from "@/modules/user/dtos/user-dto";

import { summarizeUserList } from "@/modules/user/usecases/list-users/user-list";

/**
 * One suite, two implementations (decision 13.2, TEST-PAR-3): the Prisma
 * user repository against Postgres and the in-memory twin the unit tests
 * use, fed the same rows, must answer the same. The twin used to compare
 * e-mails case-sensitively, list every user of the platform to a MASTER
 * (other masters and the asker included), hand the password hash out, and
 * leave refresh tokens alive after a password change or a revocation — so a
 * unit test could pass on behaviour the database does not have.
 */
const prisma = new PrismaClient();

const A = randomUUID();
const B = randomUUID();
const RUN = randomUUID().slice(0, 8);

let cnpj = 53000000000100 + Math.floor(Math.random() * 1_000_000);

async function seedBusiness(id: string) {
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
      vehicle_limit: 10,
    },
  });
}

interface Harness {
  name: string;
  repo: IUserRepository;
  tokens: IUsersTokensRepository;
  set: (userId: string, fields: Partial<Prisma.UserUncheckedUpdateInput>) => Promise<void>;
  addPush: (userId: string) => Promise<void>;
  pushCount: (userId: string) => Promise<number>;
  addNotification: (userId: string) => Promise<void>;
  notificationCount: (userId: string) => Promise<number>;
  refreshCount: (userId: string) => Promise<number>;
  /** A delivery row addressed to the user, in the given state. */
  addDelivery: (userId: string, status: "PENDING" | "PROCESSING" | "DELIVERED") => Promise<void>;
  deliveryStatuses: (userId: string) => Promise<string[]>;
}

const prismaTokens = new UserTokensRepository();
const memoryTokens = new InMemoryUserTokensRepository();
const memory = new InMemoryUserRepository({ tokens: memoryTokens });

const harnesses: Harness[] = [
  {
    name: "prisma",
    repo: new UserRepository(prisma as never),
    tokens: prismaTokens,
    set: async (userId, fields) => {
      await prisma.user.update({ where: { id: userId }, data: fields });
    },
    addPush: async (userId) => {
      await prisma.pushDeviceToken.create({
        data: { userId, token: `ExponentPushToken[${randomUUID()}]`, platform: "android" },
      });
    },
    pushCount: (userId) => prisma.pushDeviceToken.count({ where: { userId } }),
    addNotification: async (userId) => {
      await prisma.notification.create({
        data: { type: "t", title: "Título", message: "Mensagem", userId },
      });
    },
    notificationCount: (userId) => prisma.notification.count({ where: { userId } }),
    refreshCount: (userId) => prisma.refreshToken.count({ where: { userId } }),
    addDelivery: async (userId, status) => {
      const event = await prisma.domainOutboxEvent.create({
        data: {
          eventKey: `user-contract:${randomUUID()}`,
          topic: "account-payable.created",
          aggregateType: "account-payable",
          aggregateId: randomUUID(),
          businessId: A,
          status: "PUBLISHED",
          payload: {},
        },
      });

      // availableAt ahead: nothing else in the process may claim it.
      await prisma.notificationDelivery.create({
        data: {
          outboxEventId: event.id,
          userId,
          channel: "IN_APP",
          status,
          availableAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    },
    deliveryStatuses: async (userId) =>
      (
        await prisma.notificationDelivery.findMany({ where: { userId }, select: { status: true } })
      )
        .map((row) => row.status)
        .sort(),
  },
  {
    name: "in-memory",
    repo: memory,
    tokens: memoryTokens,
    set: async (userId, fields) => {
      const row = memory.user.find((user) => user.id === userId)!;
      Object.assign(row, fields);
    },
    addPush: async (userId) => {
      memory.pushDeviceTokens.push({ userId });
    },
    pushCount: async (userId) =>
      memory.pushDeviceTokens.filter((row) => row.userId === userId).length,
    addNotification: async (userId) => {
      memory.notifications.push({ userId });
    },
    notificationCount: async (userId) =>
      memory.notifications.filter((row) => row.userId === userId).length,
    refreshCount: async (userId) =>
      memoryTokens.refreshTokenItems.filter((row) => row.userId === userId).length,
    addDelivery: async (userId, status) => {
      memory.notificationDeliveries.push({ userId, status });
    },
    deliveryStatuses: async (userId) =>
      memory.notificationDeliveries
        .filter((row) => row.userId === userId)
        .map((row) => row.status)
        .sort(),
  },
];

/** The same people in both stores; ids differ, names and e-mails do not. */
const people: Array<{
  key: string;
  name: string;
  role: UserRole;
  business: "A" | "B" | null;
  profile?: "ops" | "fin";
  driver?: boolean;
  revoked?: boolean;
  twoFactor?: boolean;
  verified?: boolean;
  minutes: number;
}> = [
  { key: "asker-admin", name: "Gestora Principal", role: "BUSINESS_ADMIN", business: "A", minutes: 1 },
  { key: "admin-2", name: "Bruno Administrador", role: "BUSINESS_ADMIN", business: "A", twoFactor: true, verified: true, minutes: 2 },
  { key: "ops-1", name: "Carla Operação", role: "BUSINESS_USER", business: "A", profile: "ops", verified: true, minutes: 3 },
  { key: "ops-2", name: "Diego Operação", role: "BUSINESS_USER", business: "A", profile: "ops", revoked: true, minutes: 4 },
  { key: "fin-1", name: "Elisa Financeiro", role: "BUSINESS_USER", business: "A", profile: "fin", twoFactor: true, minutes: 5 },
  { key: "driver-1", name: "Fábio Motorista", role: "BUSINESS_USER", business: "A", driver: true, minutes: 6 },
  { key: "tie-1", name: "Gabi Empate", role: "BUSINESS_USER", business: "A", profile: "ops", minutes: 7 },
  { key: "tie-2", name: "Gabi Empate", role: "BUSINESS_USER", business: "A", profile: "ops", minutes: 7 },
  { key: "other-company", name: "Hugo Outra Empresa", role: "BUSINESS_USER", business: "B", minutes: 8 },
  { key: "master-1", name: "Master Um", role: "MASTER", business: null, minutes: 9 },
  { key: "master-2", name: "Master Dois", role: "MASTER", business: null, revoked: true, minutes: 10 },
];

const ids = new Map<string, Map<string, string>>(
  harnesses.map((harness) => [harness.name, new Map<string, string>()]),
);

let OPS = "";
let FIN = "";
let DRIVER = "";

const START = Date.UTC(2026, 0, 1, 12, 0, 0);

function idOf(harness: Harness, key: string): string {
  return ids.get(harness.name)!.get(key)!;
}

function keyOf(harness: Harness, id: string): string | undefined {
  for (const [key, value] of ids.get(harness.name)!) if (value === id) return key;

  return undefined;
}

const emailOf = (key: string) => `${key}.${RUN}@Exemplo.com.br`;

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  OPS = (await prisma.profileAccess.create({ data: { name: "Operação", businessId: A } })).id;
  FIN = (await prisma.profileAccess.create({ data: { name: "Financeiro", businessId: A } })).id;

  DRIVER = (
    await prisma.driver.create({
      data: {
        name: "Motorista Ferreira",
        birth_date: new Date("1990-01-01T03:00:00.000Z"),
        cnh: `7${RUN.replace(/\D/g, "0").padEnd(9, "1")}0`,
        cpf: `6${RUN.replace(/\D/g, "0").padEnd(9, "1")}0`,
        rg: "123456789",
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

  const opsGrant = await prisma.permission.create({
    data: {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      canWrite: false,
      businessId: A,
      profileAccessId: OPS,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: A, module: "DELIVERIES", enabled: true },
  });

  memory.profilePermissions.set(OPS, [
    {
      id: opsGrant.id,
      permissionKey: "kanban_manage",
      action: "kanban_manage",
      canRead: true,
      canWrite: false,
    },
  ]);
  memory.businesses.set(A, {
    is_active: true,
    entitlements: [{ module: "DELIVERIES", enabled: true }],
  });

  memory.profiles.set(OPS, { name: "Operação", businessId: A });
  memory.profiles.set(FIN, { name: "Financeiro", businessId: A });
  memory.driverNames.set(DRIVER, "Motorista Ferreira");
  memory.drivers.set(DRIVER, {
    id: DRIVER,
    status: "ACTIVE",
    businessId: A,
    branchId: null,
    branch: null,
  });

  for (const harness of harnesses) {
    for (const person of people) {
      const created = await harness.repo.createUser({
        email: emailOf(person.key),
        name: person.name,
        password: "$2a$08$hash.do.contrato.................................",
        role: person.role,
        businessId: (person.business === "A" ? A : person.business === "B" ? B : null) as string,
        profileAccessId: person.profile === "ops" ? OPS : person.profile === "fin" ? FIN : null,
        driverId: person.driver ? DRIVER : null,
      });

      ids.get(harness.name)!.set(person.key, created.id);

      await harness.set(created.id, {
        created_at: new Date(START + person.minutes * 60_000),
        access_revoked: person.revoked ?? false,
        two_factor_enabled: person.twoFactor ?? false,
        email_verified: person.verified ? new Date(START) : null,
      });
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: Array.from(ids.get("prisma")!.values()) } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

describe.each(harnesses.map((harness) => [harness.name, harness] as const))(
  "%s user repository",
  (_name, harness) => {
    it("finds an e-mail whatever its case, and only in the given company", async () => {
      const found = await harness.repo.findUserByEmail(emailOf("ops-1").toLowerCase());

      expect(found?.id).toBe(idOf(harness, "ops-1"));

      const inA = await harness.repo.findUserByEmailAndBusinessId(
        emailOf("ops-1").toUpperCase(),
        A,
      );
      const inB = await harness.repo.findUserByEmailAndBusinessId(emailOf("ops-1"), B);

      expect(inA?.id).toBe(idOf(harness, "ops-1"));
      expect(inB).toBeNull();
    });

    it("refuses a second account with the same e-mail (P2002)", async () => {
      await expect(
        harness.repo.createUser({
          email: emailOf("ops-1"),
          name: "Duplicada Pessoa",
          password: "x",
          role: "BUSINESS_USER",
          businessId: A,
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses to update a user that does not exist (P2025)", async () => {
      await expect(
        harness.repo.updateUser({ userId: randomUUID(), userData: { name: "Ninguém Aqui" } }),
      ).rejects.toMatchObject({ code: "P2025" });
    });

    it("lists one company to an administrator: no masters, not themselves, no hash", async () => {
      const page = await harness.repo.listUsers({
        page: 1,
        pageSize: 50,
        businessId: A,
        currentUserId: idOf(harness, "asker-admin"),
        currentUserRole: "BUSINESS_ADMIN",
      });

      const keys = page.data.map((row) => keyOf(harness, row.id));

      expect(keys).toEqual([
        // created_at desc, the id breaking the tie of the two "Gabi"s
        ...(idOf(harness, "tie-1") > idOf(harness, "tie-2")
          ? ["tie-1", "tie-2"]
          : ["tie-2", "tie-1"]),
        "driver-1",
        "fin-1",
        "ops-2",
        "ops-1",
        "admin-2",
      ]);

      for (const row of page.data) {
        expect(Object.keys(row)).not.toContain("password");
      }

      const carla = page.data.find((row) => keyOf(harness, row.id) === "ops-1")!;
      const fabio = page.data.find((row) => keyOf(harness, row.id) === "driver-1")!;

      expect(carla.profileAccess).toEqual({ name: "Operação" });
      expect(fabio.driver).toEqual({ name: "Motorista Ferreira" });
    });

    it("lists only users to a user, and never masters to the MASTER", async () => {
      const asUser = await harness.repo.listUsers({
        page: 1,
        pageSize: 50,
        businessId: A,
        currentUserId: idOf(harness, "ops-1"),
        currentUserRole: "BUSINESS_USER",
      });

      expect(asUser.data.every((row) => row.role === "BUSINESS_USER")).toBe(true);
      expect(asUser.data.map((row) => row.id)).not.toContain(idOf(harness, "ops-1"));

      const asMaster = await harness.repo.listUsers({
        page: 1,
        pageSize: 50,
        businessId: A,
        currentUserId: idOf(harness, "master-1"),
        currentUserRole: "MASTER",
      });

      expect(asMaster.data).toHaveLength(8);
      expect(asMaster.data.some((row) => row.role === "MASTER")).toBe(false);
    });

    it("searches names, e-mails, profile and driver names and role words", async () => {
      const search = async (term: string) =>
        (
          await harness.repo.listUsers({
            page: 1,
            pageSize: 50,
            businessId: A,
            currentUserId: idOf(harness, "asker-admin"),
            currentUserRole: "BUSINESS_ADMIN",
            search: term,
          })
        ).data
          .map((row) => keyOf(harness, row.id))
          .sort();

      expect(await search("FINANCEIRO")).toEqual(["fin-1"]);
      expect(await search("ferreira")).toEqual(["driver-1"]);
      expect(await search("administrador")).toEqual(["admin-2"]);
      expect(await search(`ops-2.${RUN}`)).toEqual(["ops-2"]);
      // A literal term: "%" is not a wildcard.
      expect(await search("%")).toEqual([]);
    });

    it("sorts by name across pages with the same tiebreaker", async () => {
      const order = async (pageNumber: number) =>
        (
          await harness.repo.listUsers({
            page: pageNumber,
            pageSize: 3,
            businessId: A,
            currentUserId: idOf(harness, "asker-admin"),
            currentUserRole: "BUSINESS_ADMIN",
            sort: "name",
            order: "asc",
          })
        ).data.map((row) => row.name);

      expect([...(await order(1)), ...(await order(2)), ...(await order(3))]).toEqual([
        "Bruno Administrador",
        "Carla Operação",
        "Diego Operação",
        "Elisa Financeiro",
        "Fábio Motorista",
        "Gabi Empate",
        "Gabi Empate",
      ]);
    });

    it("counts cards and filter options over the company, never the page", async () => {
      const page = await harness.repo.listUsers({
        page: 1,
        pageSize: 2,
        businessId: A,
        currentUserId: idOf(harness, "asker-admin"),
        currentUserRole: "BUSINESS_ADMIN",
        roles: ["BUSINESS_USER"],
        access: ["active"],
      });

      expect(page.data).toHaveLength(2);

      const { total, searchMeta } = summarizeUserList(
        page.groups,
        { roles: ["BUSINESS_USER"], access: ["active"] },
        page.profileNames,
        page.emailVerified,
      );

      // Five active BUSINESS_USERs: Carla, Elisa, Fábio and the two Gabis.
      expect(total).toBe(5);
      // Access is its own facet: counted without it (the revoked Diego too).
      expect(searchMeta.active).toBe(5);
      expect(searchMeta.revoked).toBe(1);
      expect(searchMeta.total).toBe(6);
      expect(searchMeta.twoFactor).toBe(1);
      expect(searchMeta.emailVerified).toBe(1);
      expect(searchMeta.facets.role).toEqual([
        { value: "BUSINESS_ADMIN", count: 1 },
        { value: "BUSINESS_USER", count: 5 },
      ]);
      expect(searchMeta.facets.profileAccessId).toEqual([
        { value: FIN, label: "Financeiro", count: 1 },
        { value: OPS, label: "Operação", count: 3 },
      ]);
    });

    it("ends every session and empties the inbox in one call", async () => {
      const userId = idOf(harness, "fin-1");

      await harness.tokens.createUserRefreshToken({
        userId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: randomUUID(),
        expires_in: new Date(Date.now() + 60_000),
      });
      await harness.addPush(userId);
      await harness.addNotification(userId);

      const before = (await harness.repo.findUserById(userId))!.session_version ?? 0;

      await harness.repo.endSessionsAndClearInbox(userId);

      expect((await harness.repo.findUserById(userId))!.session_version).toBe(before + 1);
      expect(await harness.refreshCount(userId)).toBe(0);
      expect(await harness.pushCount(userId)).toBe(0);
      expect(await harness.notificationCount(userId)).toBe(0);
    });

    it("drops what was not delivered yet with the inbox, and keeps the ledger", async () => {
      const userId = idOf(harness, "ops-1");

      await harness.addDelivery(userId, "PENDING");
      await harness.addDelivery(userId, "PROCESSING");
      await harness.addDelivery(userId, "DELIVERED");

      await harness.repo.endSessionsAndClearInbox(userId);

      expect(await harness.deliveryStatuses(userId)).toEqual(["DELIVERED"]);
    });

    it("refuses every write on a user that does not exist (P2025), never answering null", async () => {
      const userId = randomUUID();

      for (const write of [
        () => harness.repo.updateUserPassword({ userId, password: "x" }),
        () => harness.repo.updateUserName({ userId, name: "Ninguém Aqui" }),
        () => harness.repo.updateTwoFactorAuthentication({ userId, isTwoFactorEnabled: true }),
        () =>
          harness.repo.updateEmailVerification({
            userId,
            email: `ninguem.${RUN}@exemplo.com.br`,
            email_verified: new Date(),
          }),
        () => harness.repo.updateUserAccessRevocation({ userId, isAccessRevoke: true }),
        () => harness.repo.invalidateUserSessions(userId),
        () => harness.repo.updateAvatar(userId, null),
        () =>
          harness.repo.updateWhatsAppSettings({
            userId,
            whatsapp_notifications_enabled: false,
            whatsapp_phone: null,
          }),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: "P2025" });
      }
    });

    it("loads what the session check reads: profile permissions, company state, driver", async () => {
      const carla = (await harness.repo.findUserById(idOf(harness, "ops-1")))!;

      expect(carla.profileAccess).toEqual({
        name: "Operação",
        permissions: [
          {
            id: expect.any(String),
            permissionKey: "kanban_manage",
            action: "kanban_manage",
            canRead: true,
            canWrite: false,
          },
        ],
      });
      expect(carla.business).toEqual({
        is_active: true,
        entitlements: [{ module: "DELIVERIES", enabled: true }],
      });
      expect(carla.driver).toBeNull();

      const fabio = (await harness.repo.findUserById(idOf(harness, "driver-1")))!;

      expect(fabio.driver).toEqual({
        id: DRIVER,
        status: "ACTIVE",
        businessId: A,
        branchId: null,
        branch: null,
      });
      expect(fabio.profileAccess).toBeNull();
    });

    it("a new password and a revocation end the sessions too", async () => {
      for (const act of [
        (userId: string) => harness.repo.updateUserPassword({ userId, password: "novo-hash" }),
        (userId: string) =>
          harness.repo.updateUserAccessRevocation({ userId, isAccessRevoke: false }),
        (userId: string) => harness.repo.invalidateUserSessions(userId),
      ]) {
        const userId = idOf(harness, "tie-1");

        await harness.tokens.createUserRefreshToken({
          userId,
          token_hash: randomUUID(),
          jti: randomUUID(),
          family_id: randomUUID(),
          expires_in: new Date(Date.now() + 60_000),
        });
        await harness.addPush(userId);

        await act(userId);

        expect(await harness.refreshCount(userId)).toBe(0);
        expect(await harness.pushCount(userId)).toBe(0);
      }
    });

    it("never offers a revoked person as a recipient", async () => {
      const admins = await harness.repo.findBusinessAdminsByBusinessId(A);
      const masters = await harness.repo.findOtherMasters(idOf(harness, "asker-admin"));

      expect(admins.map((user) => keyOf(harness, user.id))).toEqual([
        "asker-admin",
        "admin-2",
      ]);
      expect(masters.map((user) => keyOf(harness, user.id))).toEqual(["master-1"]);
    });

    it("searches the picker by name or e-mail, newest first, without the hash", async () => {
      const result = await harness.repo.searchUserWithCursor({
        limit: 10,
        businessId: A,
        search: "operação",
      });

      expect(result.data.map((row) => keyOf(harness, row.id))).toEqual(["ops-2", "ops-1"]);
      expect(result.data.every((row) => !("password" in row))).toBe(true);
    });

    it("lists the masters without the asker and without the hash", async () => {
      const result = await harness.repo.listMasterUsers({
        page: 1,
        pageSize: 50,
        currentUserId: idOf(harness, "master-1"),
        search: RUN,
      });

      expect(result.data.map((row) => keyOf(harness, row.id))).toEqual(["master-2"]);
      expect(result.data.every((row) => !("password" in row))).toBe(true);
    });
  },
);
