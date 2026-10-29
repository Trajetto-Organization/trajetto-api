import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";

import {
  compareForOrder,
  type NullsPlacement,
} from "@/shared/pagination/in-memory-order";
import type { SortOrder } from "@/shared/pagination/list-query";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Where Postgres puts NULLs under the orderBy shapes a server-sorted list
 * uses (decision 8.8), next to what the twins' comparator says. A list whose
 * sort key is a nullable column or an optional relation (the delivery's
 * delivered_at, scheduled_date, its driver's name) must order the same in
 * its in-memory twin, or the twin's tests prove another screen.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fe200-0000-7000-8000-00000000000a";
const SHIPPER = "018fe200-0000-7000-8000-0000000000f1";
const ANA = "018fe200-0000-7000-8000-0000000000d1";
const BRUNO = "018fe200-0000-7000-8000-0000000000d2";

interface Row {
  recipient: string;
  driverName: string | null;
  delivered_at: Date | null;
  code: string | null;
}

/**
 * Four deliveries: two with a driver, two without; two delivered, two not.
 * The recipient is the tiebreaker, so every order below is total.
 */
const ROWS: Row[] = [
  {
    recipient: "D1",
    driverName: "Bruno",
    delivered_at: new Date("2026-09-02T12:00:00Z"),
    code: "B",
  },
  { recipient: "D2", driverName: null, delivered_at: null, code: null },
  {
    recipient: "D3",
    driverName: "Ana",
    delivered_at: new Date("2026-09-01T12:00:00Z"),
    code: "A",
  },
  {
    recipient: "D4",
    driverName: null,
    delivered_at: new Date("2026-09-03T12:00:00Z"),
    code: null,
  },
];

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da ordem",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "31222555000999",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${BUSINESS}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: BUSINESS },
  });

  for (const [id, name] of [
    [ANA, "Ana"],
    [BRUNO, "Bruno"],
  ] as const) {
    await prisma.driver.create({
      data: {
        id,
        name,
        birth_date: new Date("1990-01-01"),
        cnh: `${id}-cnh`,
        cpf: `${id}-cpf`,
        rg: `${id}-rg`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: BUSINESS,
      },
    });
  }

  const driverIds: Record<string, string> = { Ana: ANA, Bruno: BRUNO };

  for (const row of ROWS) {
    await prisma.delivery.create({
      data: {
        recipient_name: row.recipient,
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
        businessId: BUSINESS,
        shipperId: SHIPPER,
        driverId: row.driverName ? driverIds[row.driverName] : null,
        delivered_at: row.delivered_at,
        code: row.code,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function fromDatabase(
  orderBy: Prisma.DeliveryOrderByWithRelationInput,
): Promise<string[]> {
  const rows = await prisma.delivery.findMany({
    where: { businessId: BUSINESS },
    orderBy: [orderBy, { recipient_name: "asc" }],
    select: { recipient_name: true },
  });

  return rows.map((row) => row.recipient_name);
}

function fromTwin(
  value: (row: Row) => string | Date | null,
  order: SortOrder,
  nulls?: NullsPlacement,
): string[] {
  return [...ROWS]
    .sort(
      (a, b) =>
        compareForOrder(value(a), value(b), order, nulls) ||
        compareForOrder(a.recipient, b.recipient, "asc"),
    )
    .map((row) => row.recipient);
}

describe("NULL placement: Postgres and the twins agree", () => {
  it("puts an optional relation's NULLs last on asc and first on desc", async () => {
    for (const order of ["asc", "desc"] as const) {
      const database = await fromDatabase({ driver: { name: order } });

      expect(database).toEqual(fromTwin((row) => row.driverName, order));
    }

    // Spelled out once, so the default is visible here and not only derived.
    expect(await fromDatabase({ driver: { name: "desc" } })).toEqual([
      "D2",
      "D4",
      "D1",
      "D3",
    ]);
  });

  it("puts a nullable column's NULLs last on asc and first on desc by default", async () => {
    for (const order of ["asc", "desc"] as const) {
      expect(await fromDatabase({ delivered_at: order })).toEqual(
        fromTwin((row) => row.delivered_at, order),
      );
    }
  });

  it("keeps NULLs where { nulls } says, in both directions", async () => {
    for (const order of ["asc", "desc"] as const) {
      for (const nulls of ["first", "last"] as const) {
        expect(
          await fromDatabase({ delivered_at: { sort: order, nulls } }),
        ).toEqual(fromTwin((row) => row.delivered_at, order, nulls));

        expect(await fromDatabase({ code: { sort: order, nulls } })).toEqual(
          fromTwin((row) => row.code, order, nulls),
        );
      }
    }
  });
});
