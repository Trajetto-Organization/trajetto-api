import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import type {
  CreateDriverProps,
  Driver,
  ListDriversProps,
} from "@/modules/driver/dtos/driver-dto";

import { DriverHasOpenRoutesError } from "@/modules/driver/usecases/errors/driver-has-open-routes-error";
import { summarizeDriverList } from "@/modules/driver/usecases/list-driver/driver-list";
import { pauseTypeId } from "./support/pause-type-seed";

/**
 * One suite, two implementations (decision 13.2): the Prisma repository
 * against Postgres and the in-memory twin the unit tests use, fed the same
 * rows, must answer the same — order, filters, counts, uniqueness, the
 * deactivation guard, the picker and the export. A divergence here is a unit
 * test somewhere passing on behaviour the database does not have.
 */
const prisma = new PrismaClient();

const A = "018fe900-0000-7000-8000-00000000000a";
const B = "018fe900-0000-7000-8000-00000000000b";
const NORTE = "018fe900-0000-7000-8000-0000000000b1";

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(91222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

const SEED = [
  {
    name: "Bia Rocha",
    status: "ACTIVE",
    contract: "OWNED",
    category: "E",
    expires: "2027-03-01",
    branch: NORTE,
    city: "Campinas",
  },
  {
    name: "Ana Souza",
    status: "INACTIVE",
    contract: "THIRD_PARTY",
    category: "AB",
    expires: null,
    branch: null,
    city: "São Paulo",
  },
  {
    name: "Caio Lima",
    status: "ACTIVE",
    contract: "THIRD_PARTY",
    category: null,
    expires: "2026-01-10",
    branch: NORTE,
    city: "Santos",
  },
  {
    name: "Duda Reis",
    status: "ACTIVE",
    contract: "OWNED",
    category: "AB",
    expires: "2027-03-01",
    branch: null,
    city: "Campinas",
  },
  {
    name: "Enzo Melo",
    status: "ACTIVE",
    contract: "OWNED",
    category: "A",
    expires: null,
    branch: NORTE,
    city: "Sorocaba",
  },
] as const;

const prismaRepo = new DriverRepository(prisma as never);
const memoryRoutes: Array<{ driverId: string; status: string }> = [];
const memoryPauses: Array<{ driverId: string }> = [];
const memoryRepo = new InMemoryDriverRepository(memoryRoutes, memoryPauses);

const ids: string[] = [];

const both: Array<[string, IDriverRepository]> = [
  ["prisma", prismaRepo],
  ["in-memory", memoryRepo],
];

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  await prisma.branch.create({
    data: {
      id: NORTE,
      corporate_reason: "Filial Norte",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "91222555000999",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `norte-${randomUUID()}@exemplo.com.br`,
      businessId: A,
    },
  });

  memoryRepo.branchNames.set(NORTE, "Filial Norte");
  memoryRepo.branchBusiness.set(NORTE, A);

  const start = Date.now() - 60 * 60 * 1000;

  for (const [index, entry] of SEED.entries()) {
    const row = await prisma.driver.create({
      data: {
        name: entry.name,
        birth_date: new Date("1990-01-01T03:00:00.000Z"),
        cnh: `5000000000${index}`,
        cpf: `6000000000${index}`,
        cnh_category: entry.category,
        cnh_expires_at: entry.expires
          ? new Date(`${entry.expires}T00:00:00.000Z`)
          : null,
        rg: "123456789",
        cep: `0100100${index}`,
        city: entry.city,
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: entry.status,
        contract_type: entry.contract,
        businessId: A,
        branchId: entry.branch,
        created_at: new Date(start + index * 60_000),
      },
    });

    ids.push(row.id);
    // The very row Postgres holds, so both sides start from the same data.
    memoryRepo.drivers.push({ ...row } as Driver);
  }

  // Another company's driver with the same documents as Bia.
  const foreign = await prisma.driver.create({
    data: {
      name: "Bia Rocha",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: "50000000000",
      cpf: "60000000000",
      rg: "123456789",
      cep: "01001000",
      city: "Rio",
      uf: "RJ",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: B,
    },
  });

  memoryRepo.drivers.push({ ...foreign } as Driver);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const page = (props: Partial<ListDriversProps> = {}): ListDriversProps => ({
  page: 1,
  pageSize: 10,
  businessId: A,
  ...props,
});

async function names(
  repo: IDriverRepository,
  props: Partial<ListDriversProps>,
) {
  const result = await repo.listDrivers(page(props));

  return result.data.map((row) => row.name);
}

describe.each(both)("listDrivers (%s)", (_label, repo) => {
  it("orders newest first by default, inside the company only", async () => {
    expect(await names(repo, {})).toEqual([
      "Enzo Melo",
      "Duda Reis",
      "Caio Lima",
      "Ana Souza",
      "Bia Rocha",
    ]);
  });

  it("sorts by name and pages after sorting", async () => {
    expect(
      await names(repo, { sort: "name", order: "asc", pageSize: 2, page: 2 }),
    ).toEqual(["Caio Lima", "Duda Reis"]);
  });

  it("sorts categories in the enum's order with blanks last, both ways", async () => {
    expect(await names(repo, { sort: "cnh_category", order: "asc" })).toEqual([
      "Enzo Melo", // A
      "Bia Rocha", // E
      "Duda Reis", // AB (newest of the tie first)
      "Ana Souza", // AB
      "Caio Lima", // none
    ]);
    expect(await names(repo, { sort: "cnh_category", order: "desc" })).toEqual([
      "Duda Reis",
      "Ana Souza",
      "Bia Rocha",
      "Enzo Melo",
      "Caio Lima",
    ]);
  });

  it("sorts the expiry with blanks last and the tiebreaker inside equal days", async () => {
    expect(
      await names(repo, { sort: "cnh_expires_at", order: "desc" }),
    ).toEqual([
      "Duda Reis",
      "Bia Rocha",
      "Caio Lima",
      "Enzo Melo",
      "Ana Souza",
    ]);
  });

  it("filters by every facet and searches digits and text", async () => {
    expect(
      await names(repo, {
        statuses: ["ACTIVE"],
        contractTypes: ["OWNED"],
        cnhCategories: ["AB", "NONE"],
      }),
    ).toEqual(["Duda Reis"]);
    expect(await names(repo, { branchIds: [NORTE], search: "camp" })).toEqual([
      "Bia Rocha",
    ]);
    expect(await names(repo, { search: "01001-002" })).toEqual(["Caio Lima"]);
    expect(await names(repo, { search: "%" })).toEqual([]);
  });

  it("groups the same counts and names only this company's branches", async () => {
    const result = await repo.listDrivers(page({ search: "a" }));
    const summary = summarizeDriverList(
      result.groups,
      { statuses: ["ACTIVE"] },
      result.branchNames,
    );

    expect(summary.total).toBe(4);
    expect(summary.searchMeta).toMatchObject({
      total: 5,
      active: 4,
      inactive: 1,
      owned: 3,
      thirdParty: 1,
    });
    expect(summary.searchMeta.facets.branchId).toEqual([
      { value: NORTE, label: "Filial Norte", count: 3 },
    ]);
  });
});

describe.each(both)("lookups and uniqueness (%s)", (_label, repo) => {
  it("finds a CPF and a CNH inside the company only", async () => {
    expect((await repo.findDriverByCpf("60000000000", A))?.businessId).toBe(A);
    expect((await repo.findDriverByCpf("60000000000", B))?.businessId).toBe(B);
    expect(await repo.findDriverByCnh("50000000001", B)).toBeNull();
  });

  it("answers a missing row with P2025 on update and delete, deleting nothing else", async () => {
    const missing = "018fe900-0000-7000-8000-0000000000ff";
    const before = await repo.countDriversForExport({ businessId: A });

    await expect(repo.deleteDriver(missing)).rejects.toMatchObject({
      code: "P2025",
    });
    await expect(
      repo.updateDriver({ driverId: missing, driverData: { city: "Nenhuma" } }),
    ).rejects.toMatchObject({ code: "P2025" });

    expect(await repo.countDriversForExport({ businessId: A })).toBe(before);
  });

  it("answers a duplicate CPF in the same company with P2002 naming the field", async () => {
    const attempt = repo.createDriver({
      name: "Clone",
      birth_date: new Date("1990-01-01"),
      cnh: "59999999999",
      cpf: "60000000001",
      rg: "1",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: A,
    } as CreateDriverProps);

    await expect(attempt).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    await expect(attempt).rejects.toMatchObject({ code: "P2002" });

    const error = await attempt.catch((reason) => reason);

    expect(JSON.stringify(error.meta?.target)).toContain("cpf");
  });
});

describe.each(both)("the deactivation guard (%s)", (label, repo) => {
  it("refuses with the counts while routes are open, and applies once they are not", async () => {
    const driverId = ids[label === "prisma" ? 0 : 3];

    if (label === "prisma") {
      await prisma.route.createMany({
        data: [
          {
            code: 1,
            scheduled_date: new Date("2026-09-28"),
            businessId: A,
            driverId,
            status: "RELEASED",
          },
          {
            code: 2,
            scheduled_date: new Date("2026-09-28"),
            businessId: A,
            driverId,
            status: "COMPLETED",
          },
        ],
      });
    } else {
      memoryRoutes.push(
        { driverId, status: "RELEASED" },
        { driverId, status: "COMPLETED" },
      );
    }

    expect(await repo.countOpenRoutes(driverId)).toEqual({
      PLANNED: 0,
      RELEASED: 1,
      IN_PROGRESS: 0,
    });

    const refused = await repo
      .updateDriver({ driverId, driverData: { status: "INACTIVE" } })
      .catch((reason) => reason);

    expect(refused).toBeInstanceOf(DriverHasOpenRoutesError);
    expect(refused.openRoutes).toEqual({
      PLANNED: 0,
      RELEASED: 1,
      IN_PROGRESS: 0,
    });

    if (label === "prisma") {
      await prisma.route.updateMany({
        where: { driverId },
        data: { status: "CANCELLED" },
      });
    } else {
      for (const route of memoryRoutes) route.status = "CANCELLED";
    }

    const updated = await repo.updateDriver({
      driverId,
      driverData: { status: "INACTIVE", complement: null },
    });

    expect(updated.status).toBe("INACTIVE");
    expect(updated.complement).toBeNull();

    // Put back for the other suites.
    await repo.updateDriver({ driverId, driverData: { status: "ACTIVE" } });
  });

  it("stores the expiry as the civil day and clears it with null", async () => {
    const driverId = ids[4];

    const set = await repo.updateDriver({
      driverId,
      driverData: { cnh_expires_at: new Date("2031-07-09T00:00:00.000Z") },
    });

    expect(set.cnh_expires_at?.toISOString()).toBe("2031-07-09T00:00:00.000Z");

    const cleared = await repo.updateDriver({
      driverId,
      driverData: { cnh_expires_at: null },
    });

    expect(cleared.cnh_expires_at).toBeNull();
  });
});

describe.each(both)("the picker (%s)", (_label, repo) => {
  it("lists active drivers alphabetically, with the projection asked for", async () => {
    const catalog = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 10,
    });
    const choice = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 10,
      projection: "choice",
    });

    expect(catalog.data.map((row) => row.name)).toEqual([
      "Bia Rocha",
      "Caio Lima",
      "Duda Reis",
      "Enzo Melo",
    ]);
    expect(Object.keys(choice.data[0]).sort()).toEqual(
      ["cnh_category", "cnh_expires_at", "id", "name", "status"].sort(),
    );
  });

  it("searches the CNH for the catalogue only", async () => {
    const catalog = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 10,
      search: "50000000002",
    });
    const choice = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 10,
      search: "50000000002",
      projection: "choice",
    });

    expect(catalog.data.map((row) => row.name)).toEqual(["Caio Lima"]);
    expect(choice.data).toEqual([]);
  });

  it("continues after the cursor in the same order", async () => {
    const first = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 2,
    });
    const second = await repo.searchDriverWithCursor({
      businessId: A,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.hasMore).toBe(true);
    expect(second.data.map((row) => row.name)).toEqual([
      "Duda Reis",
      "Enzo Melo",
    ]);
  });
});

describe.each(both)("the export stream (%s)", (_label, repo) => {
  it("follows the list's filter and order", async () => {
    const rows: Array<{ name: string }> = [];

    for await (const row of repo.streamDriversForExport({
      businessId: A,
      statuses: ["ACTIVE"],
      sort: "name",
      order: "desc",
    })) {
      rows.push(row);
    }

    expect(rows.map((row) => row.name)).toEqual([
      "Enzo Melo",
      "Duda Reis",
      "Caio Lima",
      "Bia Rocha",
    ]);
  });

  it("counts a company's drivers and pauses", async () => {
    expect(await repo.countDriversForExport({ businessId: A })).toBe(5);
    // The export's count follows the list's filter, as the stream does.
    expect(
      await repo.countDriversForExport({ businessId: A, statuses: ["ACTIVE"] }),
    ).toBe(4);
    expect(
      await repo.countDriversForExport({
        businessId: A,
        search: "nenhum-motorista-assim",
      }),
    ).toBe(0);
    expect(await repo.countDriverPauses(ids[1])).toBe(0);
  });
});

/**
 * Names with accents and lowercase initials, in a company of their own.
 *
 * The twin compares text by code point. Production, CI and this test run
 * `postgres:16-alpine`, whose musl libc collates `en_US.utf8` byte by byte
 * too: uppercase, then lowercase, then accented initials. Pinning the order
 * here means a move to a glibc image (which interleaves them) fails loudly
 * instead of leaving the twin quietly wrong.
 */
const C = "018fe900-0000-7000-8000-00000000000c";
const ACCENTED = [
  "Élio Ramos",
  "bia Costa",
  "Zeca Lima",
  "Ágata Nunes",
  "Ana Prado",
  "Bruno Dias",
];
const accentedIds: string[] = [];

let accentedSeed: Promise<void> | null = null;

/** Once per file, whichever describe asks first (a -t filter may skip the other). */
function seedAccented(): Promise<void> {
  accentedSeed ??= (async () => {
    await seedBusiness(C);

    for (const [index, name] of ACCENTED.entries()) {
      const row = await prisma.driver.create({
        data: {
          name,
          birth_date: new Date("1990-01-01T00:00:00.000Z"),
          cnh: `7100000000${index}`,
          cpf: `7200000000${index}`,
          rg: "1",
          cep: "01001000",
          city: "Campinas",
          uf: "SP",
          street: "Rua",
          address_number: "1",
          status: "ACTIVE",
          contract_type: "OWNED",
          businessId: C,
        },
      });

      accentedIds.push(row.id);
      memoryRepo.drivers.push({ ...row } as Driver);
    }
  })();

  return accentedSeed;
}

describe("text order with accents and case", () => {
  beforeAll(seedAccented);

  const CODE_POINT_ORDER = [
    "Ana Prado",
    "Bruno Dias",
    "Zeca Lima",
    "bia Costa",
    "Ágata Nunes",
    "Élio Ramos",
  ];

  it.each(both)(
    "sorts names as the database does (%s)",
    async (_label, repo) => {
      const asc = await repo.listDrivers(
        page({ businessId: C, sort: "name", order: "asc" }),
      );
      const desc = await repo.listDrivers(
        page({ businessId: C, sort: "name", order: "desc" }),
      );

      expect(asc.data.map((row) => row.name)).toEqual(CODE_POINT_ORDER);
      expect(desc.data.map((row) => row.name)).toEqual(
        [...CODE_POINT_ORDER].reverse(),
      );
    },
  );

  it.each(both)(
    "pages the picker in the same order (%s)",
    async (_label, repo) => {
      const first = await repo.searchDriverWithCursor({
        businessId: C,
        limit: 3,
      });
      const second = await repo.searchDriverWithCursor({
        businessId: C,
        limit: 3,
        cursor: first.nextCursor ?? undefined,
      });

      expect([...first.data, ...second.data].map((row) => row.name)).toEqual(
        CODE_POINT_ORDER,
      );
    },
  );
});

describe("the delete re-checks the history itself", () => {
  beforeAll(seedAccented);

  it.each(both)(
    "refuses a driver with a pause even when nobody asked before (%s)",
    async (label, repo) => {
      const driverId = label === "prisma" ? accentedIds[0] : accentedIds[1];

      if (label === "prisma") {
        await prisma.driverPause.create({
          data: {
            kind: "MEAL",
            started_at: new Date("2026-09-28T15:00:00.000Z"),
            start_submission_id: randomUUID(),
            driverId,
            businessId: C,
            occurrenceTypeId: await pauseTypeId(prisma, C, "MEAL"),
          },
        });
      } else {
        memoryPauses.push({ driverId });
      }

      await expect(repo.deleteDriver(driverId)).rejects.toMatchObject({
        code: "DRIVER_HAS_PAUSES",
        statusCode: 409,
      });
      expect(await repo.findDriverById(driverId)).not.toBeNull();
    },
  );

  it.each(both)(
    "deletes a driver without history (%s)",
    async (label, repo) => {
      const driverId = label === "prisma" ? accentedIds[2] : accentedIds[3];

      expect((await repo.deleteDriver(driverId)).id).toBe(driverId);
      expect(await repo.findDriverById(driverId)).toBeNull();
    },
  );
});
