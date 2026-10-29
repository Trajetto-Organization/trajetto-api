import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Prisma } from "@prisma/client";

import { ShipperRepository } from "@/modules/shipper/repositories/shipper-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";

import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { StatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/status-change-reason-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";

import type { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import type { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";
import type { IStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/IStatus-change-reason-repository";
import type { IImportRepository } from "@/modules/import/repositories/IImport-repository";

import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";
import type { StatusChangeReason } from "@/modules/status-change-reason/dtos/status-change-reason-dto";
import type {
  ImportRecord,
  ImportReport,
} from "@/modules/import/dtos/import-dto";

import { expectPrismaCode } from "../contract/support";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The catalog repositories' contract (decision 13.2): ONE suite, run against
 * the Prisma repository over Postgres and against its in-memory twin, seeded
 * with the same rows.
 *
 * The twins back every unit test of the Embarcadores, Tipos, Motivos and
 * Importações use cases. A twin that orders, filters or groups differently
 * from the `where`/`orderBy`/GROUP BY the real one sends lets a unit test
 * prove what the screen never shows.
 *
 * Name order: the database is created en_US.utf8 on postgres:16-alpine (dev,
 * CI and the production default), and musl implements that locale's
 * collation as byte order — UTF-8 bytes order like code points, which is
 * what the twins compare. "The collation" block pins it with lowercase and
 * accented initials: a glibc image (POSTGRES_IMAGE) would sort "água" next to
 * "Alfa" and fail here, which is the signal to change the twins with it.
 *
 * Every catalog also has a row of ANOTHER company that matches the searches
 * and filters below, so each exact list and group also proves the tenant
 * filter.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fde00-0000-7000-8000-00000000000a";
const OTHER = "018fde00-0000-7000-8000-00000000000b";

const USER = "018fde00-0000-7000-8000-0000000000a1";
const DELIVERY = "018fde00-0000-7000-8000-0000000000d1";

/** A fixed id per row, so the tiebreaker's `id desc` is predictable. */
const idOf = (prefix: string, n: number) =>
  `018fde00-0000-7000-8000-${prefix}${String(n).padStart(10, "0")}`;

const T0 = new Date("2026-09-01T12:00:00.000Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

// ---------------------------------------------------------------------------
// Fixtures. Each has a same-instant pair whose BIGGER id is inserted first:
// without the id in the tiebreaker, Postgres returns ties in any order.
// ---------------------------------------------------------------------------

const SHIPPERS = [
  {
    id: idOf("5a", 1),
    name: "Alfa Transportes",
    cnpj: "11222333000181",
    is_active: true,
    created_at: at(1),
  },
  {
    id: idOf("5a", 2),
    name: "Bravo Bebidas",
    cnpj: null,
    is_active: false,
    created_at: at(2),
  },
  {
    id: idOf("5a", 3),
    name: "Charlie Loja 2",
    cnpj: "45723174000110",
    is_active: true,
    created_at: at(3),
  },
  {
    id: idOf("5a", 4),
    name: "Delta Atacado",
    cnpj: "22333444000192",
    is_active: true,
    created_at: at(4),
  },
  {
    id: idOf("5b", 9),
    name: "Echo",
    cnpj: null,
    is_active: true,
    created_at: at(0),
  },
  {
    id: idOf("5b", 1),
    name: "Foxtrot",
    cnpj: null,
    is_active: false,
    created_at: at(0),
  },
];

const OTHER_SHIPPER = {
  id: idOf("5c", 1),
  name: "Alfa de outra transportadora",
  cnpj: "11222333000181",
  is_active: true,
  created_at: at(5),
};

const TYPES = [
  {
    id: idOf("6a", 1),
    name: "Avaria",
    description: "Carga danificada",
    is_active: true,
    blocks_delivery: true,
    requires_photo: true,
    created_at: at(1),
  },
  {
    id: idOf("6a", 2),
    name: "Bloqueio",
    description: null,
    is_active: true,
    blocks_delivery: true,
    requires_photo: false,
    created_at: at(2),
  },
  {
    id: idOf("6a", 3),
    name: "Cancelado",
    description: null,
    is_active: false,
    blocks_delivery: true,
    requires_photo: false,
    created_at: at(3),
  },
  {
    id: idOf("6a", 4),
    name: "Devolvido",
    description: "Apenas registro",
    is_active: true,
    blocks_delivery: false,
    requires_photo: false,
    created_at: at(4),
  },
  {
    id: idOf("6b", 9),
    name: "Espera",
    description: null,
    is_active: true,
    blocks_delivery: false,
    requires_photo: true,
    created_at: at(0),
  },
  {
    id: idOf("6b", 1),
    name: "Fechado",
    description: "Registro do portao",
    is_active: false,
    blocks_delivery: false,
    requires_photo: false,
    created_at: at(0),
  },
];

/** Matches the name sort, the "REGISTRO" search and every filter below. */
const OTHER_TYPE = {
  id: idOf("6c", 1),
  name: "Avaria de outra transportadora",
  description: "Registro alheio",
  is_active: true,
  blocks_delivery: true,
  requires_photo: true,
  created_at: at(5),
};

const REASONS = [
  {
    id: idOf("7a", 1),
    name: "Atraso",
    description: "Cliente pediu outro dia",
    is_active: true,
    created_at: at(1),
  },
  {
    id: idOf("7a", 2),
    name: "Balcao",
    description: null,
    is_active: false,
    created_at: at(2),
  },
  {
    id: idOf("7a", 3),
    name: "Confirmado",
    description: "Cliente confirmou",
    is_active: true,
    created_at: at(3),
  },
  {
    id: idOf("7b", 9),
    name: "Duplicado",
    description: null,
    is_active: true,
    created_at: at(0),
  },
  {
    id: idOf("7b", 1),
    name: "Erro",
    description: null,
    is_active: false,
    created_at: at(0),
  },
];

/** Matches the "cliente" search, and is cited: it would count as "em uso". */
const OTHER_REASON = {
  id: idOf("7c", 1),
  name: "Atraso de outra transportadora",
  description: "Cliente alheio",
  is_active: true,
  created_at: at(5),
};

/** The reasons some status change already cites ("Em uso"). */
const CITED_REASONS = [idOf("7a", 3), idOf("7a", 2)];

const OTHER_USER = "018fde00-0000-7000-8000-0000000000a2";
const OTHER_DELIVERY = "018fde00-0000-7000-8000-0000000000d2";

/**
 * The collation block's company: lowercase and accented initials, and a
 * space against a letter, in an order code points and a linguistic collation
 * disagree on.
 */
const COLLATION = "018fde00-0000-7000-8000-00000000000c";

const COLLATION_NAMES = [
  "Zulu",
  "água Pura",
  "Loja B",
  "Ótica Central",
  "beta Loja",
  "Lojaa",
  "Alfa Transportes",
  "zeta",
  "Bravo Bebidas",
];

/** Byte order of the UTF-8, which the alpine image's en_US.utf8 gives. */
const COLLATION_ORDER = [
  "Alfa Transportes",
  "Bravo Bebidas",
  "Loja B",
  "Lojaa",
  "Zulu",
  "beta Loja",
  "zeta",
  "Ótica Central",
  "água Pura",
];

const collationRow = (prefix: string, name: string, index: number) => ({
  id: idOf(prefix, index + 1),
  name,
  is_active: true,
  created_at: at(20 + index),
});

const IMPORTS = [
  {
    id: idOf("8a", 1),
    source: "SPREADSHEET",
    status: "COMPLETED",
    filename: "alfa.csv",
    imported: 10,
    duplicated: 0,
    invalid: 2,
    created_at: at(1),
  },
  {
    id: idOf("8a", 2),
    source: "NFE_XML",
    status: "COMPLETED",
    filename: "bravo.xml",
    imported: 1,
    duplicated: 1,
    invalid: 0,
    created_at: at(2),
  },
  {
    id: idOf("8a", 3),
    source: "SPREADSHEET",
    status: "REVERSED",
    filename: "charlie.csv",
    imported: 5,
    duplicated: 3,
    invalid: 1,
    created_at: at(3),
  },
  {
    id: idOf("8a", 4),
    source: "SPREADSHEET",
    status: "IN_PROGRESS",
    filename: "delta.csv",
    imported: 0,
    duplicated: 0,
    invalid: 0,
    created_at: at(4),
  },
  {
    id: idOf("8b", 9),
    source: "NFE_XML",
    status: "COMPLETED",
    filename: "echo.xml",
    imported: 2,
    duplicated: 0,
    invalid: 0,
    created_at: at(0),
  },
  {
    id: idOf("8b", 1),
    source: "SPREADSHEET",
    status: "COMPLETED",
    filename: "foxtrot.csv",
    imported: 2,
    duplicated: 0,
    invalid: 0,
    created_at: at(0),
  },
] as const;

/** Matches every list, sort and filter of the imports block. */
const OTHER_IMPORT = {
  id: idOf("8c", 1),
  source: "SPREADSHEET",
  status: "COMPLETED",
  filename: "alfa-alheio.csv",
  imported: 99,
  duplicated: 0,
  invalid: 0,
  created_at: at(5),
} as const;

/** The report a finished upload stores, in the column's real shape. */
function reportOf(row: {
  imported: number;
  duplicated: number;
  invalid: number;
}): ImportReport {
  return {
    imported: row.imported,
    duplicated: row.duplicated,
    invalid: row.invalid,
    unknownHeaders: [],
    rows: [],
    routes: [],
  };
}

// ---------------------------------------------------------------------------
// The two implementations, seeded alike.
// ---------------------------------------------------------------------------

interface Implementations {
  shippers: IShipperRepository;
  types: IOccurrenceTypeRepository;
  reasons: IStatusChangeReasonRepository;
  imports: IImportRepository;
}

function twins(): Implementations {
  const shippers = new InMemoryShipperRepository();
  const types = new InMemoryOccurrenceTypeRepository();
  const reasons = new InMemoryStatusChangeReasonRepository();
  const imports = new InMemoryImportRepository();

  shippers.shippers.push(
    ...SHIPPERS.map(
      (row) =>
        ({
          ...row,
          businessId: BUSINESS,
          updated_at: row.created_at,
        }) as Shipper,
    ),
    {
      ...OTHER_SHIPPER,
      businessId: OTHER,
      updated_at: OTHER_SHIPPER.created_at,
    } as Shipper,
  );

  types.occurrenceTypes.push(
    ...TYPES.map(
      (row) =>
        ({
          ...row,
          businessId: BUSINESS,
          updated_at: row.created_at,
        }) as OccurrenceType,
    ),
    {
      ...OTHER_TYPE,
      businessId: OTHER,
      updated_at: OTHER_TYPE.created_at,
    } as OccurrenceType,
  );

  reasons.statusChangeReasons.push(
    ...REASONS.map(
      (row) =>
        ({
          ...row,
          businessId: BUSINESS,
          updated_at: row.created_at,
        }) as StatusChangeReason,
    ),
    {
      ...OTHER_REASON,
      businessId: OTHER,
      updated_at: OTHER_REASON.created_at,
    } as StatusChangeReason,
  );

  for (const reasonId of [...CITED_REASONS, OTHER_REASON.id]) {
    reasons.eventCountByReasonId.set(reasonId, 1);
  }

  COLLATION_NAMES.forEach((name, index) => {
    const shipper = collationRow("9a", name, index);
    const type = collationRow("9b", name, index);
    const reason = collationRow("9c", name, index);

    shippers.shippers.push({
      ...shipper,
      businessId: COLLATION,
      updated_at: shipper.created_at,
    } as Shipper);
    types.occurrenceTypes.push({
      ...type,
      description: null,
      blocks_delivery: false,
      requires_photo: false,
      businessId: COLLATION,
      updated_at: type.created_at,
    } as OccurrenceType);
    reasons.statusChangeReasons.push({
      ...reason,
      description: null,
      businessId: COLLATION,
      updated_at: reason.created_at,
    } as StatusChangeReason);
  });

  imports.imports.push(
    ...IMPORTS.map(
      (row): ImportRecord => ({
        ...row,
        report: reportOf(row),
        reversed_at: row.status === "REVERSED" ? at(10) : null,
        businessId: BUSINESS,
        performedById: USER,
      }),
    ),
    {
      ...OTHER_IMPORT,
      report: reportOf(OTHER_IMPORT),
      reversed_at: null,
      businessId: OTHER,
      performedById: OTHER_USER,
    },
  );

  return { shippers, types, reasons, imports };
}

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedPostgres(): Promise<void> {
  await seedBusiness(BUSINESS, "55666777000101");
  await seedBusiness(OTHER, "55666777000102");
  await seedBusiness(COLLATION, "55666777000103");

  await prisma.user.create({
    data: {
      id: USER,
      name: "Despachante",
      email: `${USER}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  // One row at a time, in the fixture's order: the tie pairs go in bigger id
  // first, so physical order alone cannot agree with `id desc` for both.
  for (const row of SHIPPERS) {
    await prisma.shipper.create({ data: { ...row, businessId: BUSINESS } });
  }

  await prisma.shipper.create({
    data: { ...OTHER_SHIPPER, businessId: OTHER },
  });

  for (const row of TYPES) {
    await prisma.occurrenceType.create({
      data: { ...row, businessId: BUSINESS },
    });
  }

  await prisma.occurrenceType.create({
    data: { ...OTHER_TYPE, businessId: OTHER },
  });

  for (const row of REASONS) {
    await prisma.statusChangeReason.create({
      data: { ...row, businessId: BUSINESS },
    });
  }

  await prisma.statusChangeReason.create({
    data: { ...OTHER_REASON, businessId: OTHER },
  });

  for (const [index, name] of COLLATION_NAMES.entries()) {
    await prisma.shipper.create({
      data: { ...collationRow("9a", name, index), businessId: COLLATION },
    });
    await prisma.occurrenceType.create({
      data: { ...collationRow("9b", name, index), businessId: COLLATION },
    });
    await prisma.statusChangeReason.create({
      data: { ...collationRow("9c", name, index), businessId: COLLATION },
    });
  }

  await prisma.user.create({
    data: {
      id: OTHER_USER,
      name: "Despachante alheio",
      email: `${OTHER_USER}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: OTHER,
    },
  });

  await prisma.delivery.create({
    data: {
      id: OTHER_DELIVERY,
      recipient_name: "Cliente alheio",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER.id,
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      status_from: "PENDING",
      status_to: "FAILED",
      reasonId: OTHER_REASON.id,
      deliveryId: OTHER_DELIVERY,
      businessId: OTHER,
    },
  });

  await prisma.delivery.create({
    data: {
      id: DELIVERY,
      recipient_name: "Padaria Estrela",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: BUSINESS,
      shipperId: SHIPPERS[0].id,
    },
  });

  for (const reasonId of CITED_REASONS) {
    await prisma.deliveryEvent.create({
      data: {
        type: "STATUS_CHANGE",
        status_from: "PENDING",
        status_to: "FAILED",
        reasonId,
        deliveryId: DELIVERY,
        businessId: BUSINESS,
      },
    });
  }

  for (const row of IMPORTS) {
    await prisma.import.create({
      data: {
        ...row,
        report: reportOf(row) as unknown as Prisma.InputJsonValue,
        reversed_at: row.status === "REVERSED" ? at(10) : null,
        businessId: BUSINESS,
        performedById: USER,
      },
    });
  }

  await prisma.import.create({
    data: {
      ...OTHER_IMPORT,
      report: reportOf(OTHER_IMPORT) as unknown as Prisma.InputJsonValue,
      businessId: OTHER,
      performedById: OTHER_USER,
    },
  });
}

const implementations: Record<"prisma" | "in-memory", Implementations> = {
  prisma: {
    shippers: new ShipperRepository(prisma),
    types: new OccurrenceTypeRepository(prisma),
    reasons: new StatusChangeReasonRepository(prisma),
    imports: new ImportRepository(prisma),
  },
  "in-memory": twins(),
};

beforeAll(async () => {
  await seedPostgres();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers: what is compared is order, membership and counts.
// ---------------------------------------------------------------------------

const namesOf = (rows: ReadonlyArray<{ name: string }>) =>
  rows.map((row) => row.name);

/** GROUP BY has no order; the twin's Map has insertion order. */
function sortedGroups<T extends object>(groups: ReadonlyArray<T>): T[] {
  return [...groups].sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b)
      ? -1
      : JSON.stringify(a) > JSON.stringify(b)
        ? 1
        : 0,
  );
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe.each(["prisma", "in-memory"] as const)(
  "the catalog repositories (%s)",
  (kind) => {
    const repos = () => implementations[kind];

    describe("shippers", () => {
      const list = (
        props: Partial<Parameters<IShipperRepository["listShippers"]>[0]>,
      ) =>
        repos().shippers.listShippers({
          page: 1,
          pageSize: 10,
          businessId: BUSINESS,
          ...props,
        });

      it("orders newest first, ties by id desc, across pages, within the company", async () => {
        const first = await list({ pageSize: 4 });
        const second = await list({ pageSize: 4, page: 2 });

        expect(namesOf([...first.data, ...second.data])).toEqual([
          "Delta Atacado",
          "Charlie Loja 2",
          "Bravo Bebidas",
          "Alfa Transportes",
          "Echo",
          "Foxtrot",
        ]);
      });

      it("keeps the id desc tiebreaker when created_at is ascending", async () => {
        const { data } = await list({ sort: "created_at", order: "asc" });

        expect(namesOf(data).slice(0, 3)).toEqual([
          "Echo",
          "Foxtrot",
          "Alfa Transportes",
        ]);
      });

      it("sorts by name both ways", async () => {
        const expected = SHIPPERS.map((row) => row.name).sort(byName);

        expect(
          namesOf((await list({ sort: "name", order: "asc" })).data),
        ).toEqual(expected);
        expect(
          namesOf((await list({ sort: "name", order: "desc" })).data),
        ).toEqual([...expected].reverse());
      });

      it("filters by status, and groups over the search without the filter", async () => {
        const { data, groups } = await list({ statuses: ["inactive"] });

        expect(namesOf(data)).toEqual(["Bravo Bebidas", "Foxtrot"]);
        expect(sortedGroups(groups)).toEqual(
          sortedGroups([
            { is_active: true, count: 4, withCnpj: 3 },
            { is_active: false, count: 2, withCnpj: 0 },
          ]),
        );
      });

      it("searches a name with a digit as a name, and a masked CNPJ by its digits", async () => {
        const byName_ = await list({ search: "loja 2" });

        expect(namesOf(byName_.data)).toEqual(["Charlie Loja 2"]);
        expect(byName_.groups).toEqual([
          { is_active: true, count: 1, withCnpj: 1 },
        ]);

        expect(namesOf((await list({ search: "22.333.444" })).data)).toEqual([
          "Delta Atacado",
        ]);
        expect(namesOf((await list({ search: idOf("5a", 2) })).data)).toEqual([
          "Bravo Bebidas",
        ]);
      });

      it("pages the picker by name over active shippers, with the same search", async () => {
        const first = await repos().shippers.searchShipperWithCursor({
          limit: 2,
          businessId: BUSINESS,
        });

        expect(namesOf(first.data)).toEqual([
          "Alfa Transportes",
          "Charlie Loja 2",
        ]);
        expect(first.hasMore).toBe(true);

        const second = await repos().shippers.searchShipperWithCursor({
          limit: 2,
          businessId: BUSINESS,
          cursor: first.nextCursor ?? undefined,
        });

        expect(namesOf(second.data)).toEqual(["Delta Atacado", "Echo"]);
        expect(second.hasMore).toBe(false);

        for (const search of ["loja 2", "45.723.174/0001-10"]) {
          const found = await repos().shippers.searchShipperWithCursor({
            limit: 10,
            businessId: BUSINESS,
            search,
          });

          expect(namesOf(found.data)).toEqual(["Charlie Loja 2"]);
        }
      });
    });

    describe("occurrence types", () => {
      const list = (
        props: Partial<
          Parameters<IOccurrenceTypeRepository["listOccurrenceTypes"]>[0]
        >,
      ) =>
        repos().types.listOccurrenceTypes({
          page: 1,
          pageSize: 10,
          businessId: BUSINESS,
          ...props,
        });

      it("orders newest first, ties by id desc, and sorts by name both ways", async () => {
        expect(namesOf((await list({})).data)).toEqual([
          "Devolvido",
          "Cancelado",
          "Bloqueio",
          "Avaria",
          "Espera",
          "Fechado",
        ]);

        const expected = TYPES.map((row) => row.name).sort(byName);

        expect(
          namesOf((await list({ sort: "name", order: "asc" })).data),
        ).toEqual(expected);
        expect(
          namesOf((await list({ sort: "name", order: "desc" })).data),
        ).toEqual([...expected].reverse());
      });

      it("applies the blocking, photo and status filters, and groups without them", async () => {
        const blockingWithoutPhoto = await list({
          blocking: ["yes"],
          photo: ["no"],
        });

        expect(namesOf(blockingWithoutPhoto.data)).toEqual([
          "Cancelado",
          "Bloqueio",
        ]);

        const activeOnly = await list({ statuses: ["active"], photo: ["yes"] });

        expect(namesOf(activeOnly.data)).toEqual(["Avaria", "Espera"]);

        // One group per combination of the three columns, over the base only.
        expect(sortedGroups(blockingWithoutPhoto.groups)).toEqual(
          sortedGroups([
            {
              is_active: true,
              blocks_delivery: true,
              requires_photo: true,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: true,
              blocks_delivery: true,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: false,
              blocks_delivery: true,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: true,
              blocks_delivery: false,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: true,
              blocks_delivery: false,
              requires_photo: true,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: false,
              blocks_delivery: false,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
          ]),
        );
      });

      it("searches the name and the description, case-insensitively", async () => {
        const { data, groups } = await list({ search: "REGISTRO" });

        expect(namesOf(data)).toEqual(["Devolvido", "Fechado"]);
        expect(sortedGroups(groups)).toEqual(
          sortedGroups([
            {
              is_active: true,
              blocks_delivery: false,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
            {
              is_active: false,
              blocks_delivery: false,
              requires_photo: false,
              category: "NOT_DELIVERED",
              count: 1,
            },
          ]),
        );
      });
    });

    describe("status change reasons", () => {
      const list = (
        props: Partial<
          Parameters<
            IStatusChangeReasonRepository["listStatusChangeReasons"]
          >[0]
        >,
      ) =>
        repos().reasons.listStatusChangeReasons({
          page: 1,
          pageSize: 10,
          businessId: BUSINESS,
          ...props,
        });

      it("orders newest first, ties by id desc, and sorts by name", async () => {
        expect(namesOf((await list({})).data)).toEqual([
          "Confirmado",
          "Balcao",
          "Atraso",
          "Duplicado",
          "Erro",
        ]);

        expect(
          namesOf((await list({ sort: "name", order: "desc" })).data),
        ).toEqual(["Erro", "Duplicado", "Confirmado", "Balcao", "Atraso"]);
      });

      it("filters by status; groups and 'em uso' follow the search, not the filter", async () => {
        const active = await list({ statuses: ["active"] });

        expect(namesOf(active.data)).toEqual([
          "Confirmado",
          "Atraso",
          "Duplicado",
        ]);
        expect(sortedGroups(active.groups)).toEqual(
          sortedGroups([
            { is_active: true, count: 3 },
            { is_active: false, count: 2 },
          ]),
        );
        expect(active.used).toBe(2);

        const searched = await list({ search: "cliente" });

        expect(namesOf(searched.data)).toEqual(["Confirmado", "Atraso"]);
        expect(searched.used).toBe(1);
      });
    });

    describe("imports", () => {
      const list = (
        props: Partial<Parameters<IImportRepository["listImports"]>[0]>,
      ) =>
        repos().imports.listImports({
          page: 1,
          pageSize: 10,
          businessId: BUSINESS,
          includeReport: false,
          ...props,
        });

      const filenames = (rows: ReadonlyArray<{ filename: string }>) =>
        rows.map((row) => row.filename);

      it("orders newest first with ties by id desc, and by the counters", async () => {
        expect(filenames((await list({})).data)).toEqual([
          "delta.csv",
          "charlie.csv",
          "bravo.xml",
          "alfa.csv",
          "echo.xml",
          "foxtrot.csv",
        ]);

        // Equal counters fall back to created_at desc, then id desc.
        expect(
          filenames((await list({ sort: "imported", order: "asc" })).data),
        ).toEqual([
          "delta.csv",
          "bravo.xml",
          "echo.xml",
          "foxtrot.csv",
          "charlie.csv",
          "alfa.csv",
        ]);

        expect(
          filenames((await list({ sort: "filename", order: "desc" })).data),
        ).toEqual([
          "foxtrot.csv",
          "echo.xml",
          "delta.csv",
          "charlie.csv",
          "bravo.xml",
          "alfa.csv",
        ]);
      });

      it("filters by status and source, and groups over the company", async () => {
        const { data, groups } = await list({
          statuses: ["COMPLETED"],
          sources: ["SPREADSHEET"],
        });

        expect(filenames(data)).toEqual(["alfa.csv", "foxtrot.csv"]);
        expect(sortedGroups(groups)).toEqual(
          sortedGroups([
            { status: "COMPLETED", source: "SPREADSHEET", count: 2 },
            { status: "COMPLETED", source: "NFE_XML", count: 2 },
            { status: "REVERSED", source: "SPREADSHEET", count: 1 },
            { status: "IN_PROGRESS", source: "SPREADSHEET", count: 1 },
          ]),
        );
      });

      it("leaves the report out of the rows when asked", async () => {
        const { data } = await list({ pageSize: 1 });

        expect(data[0]).not.toHaveProperty("report");
      });
    });

    // TEST-PAR-2: a write on an id that is not there is P2025 everywhere, and
    // the twin no longer turns index -1 into "the last row".
    describe("writes on a row that does not exist", () => {
      const MISSING = idOf("9f", 99);

      it("answers P2025 and leaves every row in place", async () => {
        const { shippers, types, reasons } = repos();

        await expectPrismaCode(
          shippers.updateShipper(MISSING, { name: "X" }),
          "P2025",
        );
        await expectPrismaCode(shippers.deleteShipper(MISSING), "P2025");
        await expectPrismaCode(
          types.updateOccurrenceType(MISSING, { name: "X" }),
          "P2025",
        );
        await expectPrismaCode(types.deleteOccurrenceType(MISSING), "P2025");
        await expectPrismaCode(
          reasons.updateStatusChangeReason(MISSING, { name: "X" }),
          "P2025",
        );
        await expectPrismaCode(
          reasons.deleteStatusChangeReason(MISSING),
          "P2025",
        );

        for (const row of SHIPPERS)
          expect(await shippers.findShipperById(row.id)).not.toBeNull();
        for (const row of TYPES)
          expect(await types.findOccurrenceTypeById(row.id)).not.toBeNull();
        for (const row of REASONS)
          expect(
            await reasons.findStatusChangeReasonById(row.id),
          ).not.toBeNull();
      });

      it("refuses a second reason with the same name in the company (P2002), not in another", async () => {
        const { reasons } = repos();

        await expectPrismaCode(
          reasons.createStatusChangeReason({
            name: "Atraso",
            businessId: BUSINESS,
          }),
          "P2002",
        );
        await expectPrismaCode(
          reasons.updateStatusChangeReason(REASONS[1].id, { name: "Atraso" }),
          "P2002",
        );

        // Case-sensitive, like the plain unique index.
        const lower = await reasons.createStatusChangeReason({
          name: "atraso",
          businessId: BUSINESS,
        });
        await reasons.deleteStatusChangeReason(lower.id!);
      });
    });

    describe("the collation", () => {
      it("orders shipper, type and reason names the way the database does", async () => {
        const shippers = await repos().shippers.listShippers({
          page: 1,
          pageSize: 20,
          businessId: COLLATION,
          sort: "name",
          order: "asc",
        });
        const types = await repos().types.listOccurrenceTypes({
          page: 1,
          pageSize: 20,
          businessId: COLLATION,
          sort: "name",
          order: "asc",
        });
        const reasons = await repos().reasons.listStatusChangeReasons({
          page: 1,
          pageSize: 20,
          businessId: COLLATION,
          sort: "name",
          order: "desc",
        });

        expect(namesOf(shippers.data)).toEqual(COLLATION_ORDER);
        expect(namesOf(types.data)).toEqual(COLLATION_ORDER);
        expect(namesOf(reasons.data)).toEqual([...COLLATION_ORDER].reverse());
      });

      it("pages the picker's cursor in that same order", async () => {
        const seen: string[] = [];
        let cursor: string | undefined;

        for (let page = 0; page < 5; page += 1) {
          const result = await repos().shippers.searchShipperWithCursor({
            limit: 4,
            businessId: COLLATION,
            cursor,
          });

          seen.push(...namesOf(result.data));

          if (!result.hasMore) break;

          cursor = result.nextCursor ?? undefined;
        }

        expect(seen).toEqual(COLLATION_ORDER);
      });
    });
  },
);
