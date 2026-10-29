import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { ProfileAccessRepository } from "@/modules/profile-access/repositories/profile-access-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { PermissionRepository } from "@/modules/permission/repositories/permission-repository";
import { InMemoryPermissionRepository } from "@/modules/permission/repositories/in-memory/in-memory-permission-repository";

import type { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";
import type { IPermissionRepository } from "@/modules/permission/repositories/IPermission-repository";
import type { PermissionKey } from "@/config/permissions";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * One suite, two implementations (decision 13.2): the access-profile and
 * permission repositories against Postgres and the in-memory twins the unit
 * tests use, fed the same rows, answer the same — order and its tiebreaker,
 * search, tenant, counts, and the unique indexes. The twins sorted with
 * `localeCompare` and hand-made number comparisons instead of the shared
 * Postgres comparator, and accepted a second profile (or permission) with
 * a name the database refuses.
 */
const prisma = createPrismaClient();

const A = randomUUID();
const B = randomUUID();

let cnpj = 55000000000100 + Math.floor(Math.random() * 1_000_000);

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

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (minutes: number) => new Date(START + minutes * 60_000);

/**
 * The same profiles in both stores, with the same ids. The tie pair shares
 * `created_at`, and the one inserted first has the LARGER id: only an
 * `id desc` tiebreaker puts it first.
 */
const TIE_HIGH = "01890000-0000-7000-8000-00000000ff02";
const TIE_LOW = "01890000-0000-7000-8000-00000000ff01";

const profiles: Array<{
  key: string;
  id: string;
  name: string;
  business: string;
  minutes: number;
}> = [];

function profileId(key: string): string {
  return profiles.find((profile) => profile.key === key)!.id;
}

interface Harness {
  name: string;
  profiles: IProfileAccessRepository;
  permissions: IPermissionRepository;
}

const memoryUsers: Array<{ profileAccessId: string | null }> = [];
const memoryPermissions = new InMemoryPermissionRepository();
const memoryProfiles = new InMemoryProfileAccessRepository({
  users: () => memoryUsers,
  permissions: () => memoryPermissions.permissions,
});

const harnesses: Harness[] = [
  {
    name: "prisma",
    profiles: new ProfileAccessRepository(prisma as never),
    permissions: new PermissionRepository(prisma as never),
  },
  {
    name: "in-memory",
    profiles: memoryProfiles,
    permissions: memoryPermissions,
  },
];

const grants: Array<
  [
    profile: string,
    key: PermissionKey,
    read: boolean,
    write: boolean,
    minutes: number,
  ]
> = [
  ["ops", "kanban_manage", true, true, 1],
  ["ops", "supplier_manage", true, false, 2],
  ["fin", "account_payable_manage", true, true, 3],
  ["stock", "part_manage", true, false, 4],
];

const userLinks: Array<[profile: string, count: number]> = [
  ["ops", 2],
  ["fin", 1],
];

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  profiles.push(
    { key: "ops", id: randomUUID(), name: "Operacao", business: A, minutes: 1 },
    {
      key: "fin",
      id: randomUUID(),
      name: "Financeiro",
      business: A,
      minutes: 2,
    },
    {
      key: "stock",
      id: randomUUID(),
      name: "Almoxarifado",
      business: A,
      minutes: 3,
    },
    {
      key: "tie-high",
      id: TIE_HIGH,
      name: "Empate Alto",
      business: A,
      minutes: 4,
    },
    {
      key: "tie-low",
      id: TIE_LOW,
      name: "Empate Baixo",
      business: A,
      minutes: 4,
    },
    { key: "zeta", id: randomUUID(), name: "Zeta", business: A, minutes: 5 },
    {
      key: "other",
      id: randomUUID(),
      name: "Operacao",
      business: B,
      minutes: 6,
    },
  );

  // Postgres: the rows as the screens would have written them.
  for (const profile of profiles) {
    await prisma.profileAccess.create({
      data: {
        id: profile.id,
        name: profile.name,
        businessId: profile.business,
        created_at: at(profile.minutes),
      },
    });
  }

  for (const [profile, key, read, write, minutes] of grants) {
    await prisma.permission.create({
      data: {
        action: key,
        permissionKey: key,
        canRead: read,
        canWrite: write,
        businessId: A,
        profileAccessId: profileId(profile),
        created_at: at(minutes),
      },
    });
  }

  for (const [profile, count] of userLinks) {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();

      await prisma.user.create({
        data: {
          id,
          name: `Pessoa ${index}`,
          email: `${id}@exemplo.com.br`,
          password: "$2a$08$hash.do.contrato.................................",
          role: "BUSINESS_USER",
          businessId: A,
          profileAccessId: profileId(profile),
        },
      });

      memoryUsers.push({ profileAccessId: profileId(profile) });
    }
  }

  // The twins: the same rows, the same ids and instants.
  for (const profile of profiles) {
    const created = await memoryProfiles.createProfileAccess({
      name: profile.name,
      businessId: profile.business,
    });

    const row = memoryProfiles.profileAccess.find(
      (item) => item.id === created.id,
    )!;
    Object.assign(row, {
      id: profile.id,
      created_at: at(profile.minutes),
      updated_at: at(profile.minutes),
    });

    memoryPermissions.profiles.set(profile.id, {
      name: profile.name,
      businessId: profile.business,
    });
  }

  for (const [profile, key, read, write, minutes] of grants) {
    const created = await memoryPermissions.createPermission({
      action: key,
      permissionKey: key,
      canRead: read,
      canWrite: write,
      businessId: A,
      profileAccessId: profileId(profile),
    });

    const row = memoryPermissions.permissions.find(
      (item) => item.id === created.id,
    )!;
    Object.assign(row, { created_at: at(minutes), updated_at: at(minutes) });
  }
}, 120_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

describe.each(harnesses.map((harness) => [harness.name, harness] as const))(
  "%s access-profile and permission repositories",
  (_name, harness) => {
    const list = (extra: Record<string, unknown> = {}) =>
      harness.profiles.listProfileAccess({
        page: 1,
        pageSize: 50,
        businessId: A,
        ...extra,
      });

    it("list one company's profiles, newest first, the id breaking ties", async () => {
      const { data, total } = await list();

      expect(total).toBe(6);
      expect(names(data)).toEqual([
        "Zeta",
        "Empate Alto",
        "Empate Baixo",
        "Almoxarifado",
        "Financeiro",
        "Operacao",
      ]);
    });

    it("sort by name both ways and page two continues page one", async () => {
      const asc = await list({ sort: "name", order: "asc" });
      expect(names(asc.data)).toEqual([
        "Almoxarifado",
        "Empate Alto",
        "Empate Baixo",
        "Financeiro",
        "Operacao",
        "Zeta",
      ]);

      const desc = await list({ sort: "name", order: "desc" });
      expect(names(desc.data)).toEqual([...names(asc.data)].reverse());

      const first = await list({ sort: "name", order: "asc", pageSize: 4 });
      const second = await list({
        sort: "name",
        order: "asc",
        pageSize: 4,
        page: 2,
      });
      expect([...names(first.data), ...names(second.data)]).toEqual(
        names(asc.data),
      );
    });

    it("sort by how many people and permissions each profile holds", async () => {
      const byUsers = await list({ sort: "usersCount", order: "desc" });

      expect(byUsers.data.map((row) => [row.name, row.usersCount])).toEqual([
        ["Operacao", 2],
        ["Financeiro", 1],
        // Zero each: created_at desc, then id desc.
        ["Zeta", 0],
        ["Empate Alto", 0],
        ["Empate Baixo", 0],
        ["Almoxarifado", 0],
      ]);

      const byPermissions = await list({
        sort: "permissionsCount",
        order: "asc",
      });

      expect(
        byPermissions.data.map((row) => [row.name, row.permissionsCount]),
      ).toEqual([
        ["Zeta", 0],
        ["Empate Alto", 0],
        ["Empate Baixo", 0],
        ["Almoxarifado", 1],
        ["Financeiro", 1],
        ["Operacao", 2],
      ]);
    });

    it("search by name or id, hide the reader's own profile, never another company", async () => {
      expect(names((await list({ search: "EMPATE" })).data)).toEqual([
        "Empate Alto",
        "Empate Baixo",
      ]);
      expect(names((await list({ search: TIE_LOW.slice(-6) })).data)).toEqual([
        "Empate Baixo",
      ]);

      const hidden = await list({ hideProfileId: profileId("ops") });
      expect(names(hidden.data)).not.toContain("Operacao");
      expect(hidden.total).toBe(5);

      const other = await harness.profiles.listProfileAccess({
        page: 1,
        pageSize: 50,
        businessId: B,
      });
      expect(other.data.map((row) => row.id)).toEqual([profileId("other")]);
    });

    it("refuse a second profile with the same name in the company, not in another (P2002)", async () => {
      await expect(
        harness.profiles.createProfileAccess({
          name: "Financeiro",
          businessId: A,
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      await expect(
        harness.profiles.updateProfileAccess({
          profileAccessId: profileId("zeta"),
          name: "Financeiro",
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      const elsewhere = await harness.profiles.createProfileAccess({
        name: "Financeiro",
        businessId: B,
      });
      expect(elsewhere.businessId).toBe(B);
      await harness.profiles.deleteProfileAccess(elsewhere.id);
    });

    it("list permissions with booleans ordered as Postgres orders them", async () => {
      const { data, groups, profileNames } =
        await harness.permissions.listPermission({
          page: 1,
          pageSize: 50,
          businessId: A,
          sort: "canWrite",
          order: "asc",
        });

      // false before true; inside each, created_at desc.
      expect(data.map((row) => [row.permissionKey, row.canWrite])).toEqual([
        ["part_manage", false],
        ["supplier_manage", false],
        ["account_payable_manage", true],
        ["kanban_manage", true],
      ]);
      expect(
        data.find((row) => row.permissionKey === "kanban_manage")!
          .profileAccess,
      ).toEqual({
        name: "Operacao",
      });

      expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(4);
      expect([...profileNames.values()].sort()).toEqual([
        "Almoxarifado",
        "Financeiro",
        "Operacao",
      ]);
    });

    it("filter permissions by write and search the resource label", async () => {
      const writable = await harness.permissions.listPermission({
        page: 1,
        pageSize: 50,
        businessId: A,
        write: ["enabled"],
        sort: "permissionKey",
        order: "desc",
      });
      expect(writable.data.map((row) => row.permissionKey)).toEqual([
        "kanban_manage",
        "account_payable_manage",
      ]);

      const byName = await harness.permissions.listPermission({
        page: 1,
        pageSize: 50,
        businessId: A,
        search: "operacao",
      });
      expect(byName.data.map((row) => row.permissionKey).sort()).toEqual([
        "kanban_manage",
        "supplier_manage",
      ]);
    });

    it("refuse a second permission with the same name on the profile (P2002)", async () => {
      await expect(
        harness.permissions.createPermission({
          action: "kanban_manage",
          permissionKey: "kanban_manage",
          canRead: true,
          canWrite: false,
          businessId: A,
          profileAccessId: profileId("ops"),
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuse an update onto another permission's slot (P2002)", async () => {
      const [kanban, supplier] =
        await harness.permissions.findPermissionsByProfile(profileId("ops"), A);

      await expect(
        harness.permissions.updatePermission({
          permissionId: supplier.id,
          action: kanban.action,
          businessId: A,
          profileAccessId: profileId("ops"),
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      // The row keeps its name.
      const after = await harness.permissions.findPermissionById(supplier.id);
      expect(after?.action).toBe(supplier.action);
    });

    it("refuse a bulk set with a repeated resource and keep the old one (P2002)", async () => {
      const before = await harness.permissions.findPermissionsByProfile(
        profileId("fin"),
        A,
      );

      await expect(
        harness.permissions.bulkConfigurePermissions({
          businessId: A,
          profileAccessId: profileId("fin"),
          permissions: [
            {
              permissionKey: "supplier_manage",
              canRead: true,
              canWrite: false,
            },
            { permissionKey: "supplier_manage", canRead: true, canWrite: true },
          ],
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      expect(
        await harness.permissions.findPermissionsByProfile(profileId("fin"), A),
      ).toEqual(before);
    });

    it("read a profile's permissions in resource order", async () => {
      const rows = await harness.permissions.findPermissionsByProfile(
        profileId("ops"),
        A,
      );

      expect(rows.map((row) => row.permissionKey)).toEqual([
        "kanban_manage",
        "supplier_manage",
      ]);
      expect(
        await harness.permissions.findPermissionsByProfile(profileId("ops"), B),
      ).toEqual([]);
    });
  },
);

// Keeps the Prisma import honest: the P2002 the twin raises is Prisma's own.
it("the twins raise Prisma's own error class", async () => {
  await expect(
    memoryProfiles.createProfileAccess({ name: "Zeta", businessId: A }),
  ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
});
