import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ListDeliveryUseCase } from "@/modules/delivery/usecases/list-delivery/list-delivery-usecase";
import { ExportDeliveryUseCase } from "@/modules/delivery/usecases/export-delivery/export-delivery-usecase";
import { deliveryPeriodWindow } from "@/modules/delivery/usecases/list-delivery/delivery-period";
import {
  deliveryListWhere,
  isTenantOnlyDeliveryList,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { listDeliverySchema } from "@/schemas/list-delivery-schema";
import { exportDeliverySchema } from "@/schemas/export-delivery-schema";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * The Entregas list's period (meeting of 14/10/2026): the screen opens on
 * today with presets of 7/14/30 days and a custom range, because a carrier
 * with ~3,000 deliveries a day must not count its whole history for every
 * page. The period is civil days in the COMPANY's zone; the counts follow
 * it; omitted, every date (the API before the period). And an exact id /
 * order / NF search ignores it, or a notification's `?search=<id>` link
 * would not find last week's delivery.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000b1";
const MANAGER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-0000000000d2";

// 28/10/2026 12:00 in São Paulo (UTC-3).
const NOW = new Date("2026-10-28T15:00:00.000Z");

const OLD_ID = "018f0000-0000-7000-8000-00000000c0de";

function build() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const businesses = new InMemoryBusinessRepository();

  businesses.business.push({
    id: BUSINESS,
    timezone: "America/Sao_Paulo",
  } as unknown as Business);

  users.user.push(
    {
      id: MANAGER,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: DRIVER_USER,
      name: "João",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  deliveries.shipperNames.set(SHIPPER, "Atacado Sul");

  // [id, created_at, status, kind, code, invoice_number, driver]
  const rows: Array<
    [string, string, string, string, string | null, string | null, string]
  > = [
    // Today in São Paulo: 28/10 from 03:00Z.
    [
      "today-1",
      "2026-10-28T03:00:00.000Z",
      "PENDING",
      "DELIVERY",
      "PED-10",
      null,
      DRIVER,
    ],
    [
      "today-2",
      "2026-10-28T14:00:00.000Z",
      "DELIVERED",
      "SERVICE_ORDER",
      null,
      "777",
      DRIVER,
    ],
    // 27/10 23:59 in São Paulo: yesterday, though already the 28th in UTC.
    [
      "late-yesterday",
      "2026-10-28T02:59:00.000Z",
      "PENDING",
      "DELIVERY",
      null,
      null,
      DRIVER,
    ],
    // Five days ago, and forty days ago.
    [
      "five-days",
      "2026-10-23T15:00:00.000Z",
      "FAILED",
      "DELIVERY",
      null,
      null,
      OTHER_DRIVER,
    ],
    [
      OLD_ID,
      "2026-09-18T15:00:00.000Z",
      "DELIVERED",
      "DELIVERY",
      "PED-1",
      "45515",
      OTHER_DRIVER,
    ],
  ];

  for (const [
    id,
    createdAt,
    status,
    kind,
    code,
    invoiceNumber,
    driverId,
  ] of rows) {
    deliveries.deliveries.push({
      id,
      businessId: BUSINESS,
      shipperId: SHIPPER,
      driverId,
      recipient_name: `Cliente ${id}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status,
      kind,
      code,
      invoice_number: invoiceNumber,
      created_at: new Date(createdAt),
    } as never);
  }

  return {
    deliveries,
    list: new ListDeliveryUseCase(users, deliveries, businesses),
    exporter: new ExportDeliveryUseCase(users, deliveries, businesses),
  };
}

const ids = (result: { data: Array<{ id?: string }> }) =>
  result.data.map((row) => row.id).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the period's days, in the company's zone", () => {
  it("is today's civil day, not the server's UTC day", () => {
    const late = new Date("2026-10-28T02:00:00.000Z"); // 27/10 23:00 in SP

    expect(
      deliveryPeriodWindow({ period: "today" }, "America/Sao_Paulo", late),
    ).toEqual({
      from: "2026-10-27",
      to: "2026-10-27",
      start: new Date("2026-10-27T03:00:00.000Z"),
      end: new Date("2026-10-28T03:00:00.000Z"),
    });
  });

  it("counts today among the last N days, and reads the custom days as given", () => {
    expect(
      deliveryPeriodWindow({ period: "7d" }, "America/Manaus", NOW),
    ).toMatchObject({
      from: "2026-10-22",
      to: "2026-10-28",
      start: new Date("2026-10-22T04:00:00.000Z"),
      end: new Date("2026-10-29T04:00:00.000Z"),
    });

    expect(
      deliveryPeriodWindow(
        { period: "custom", from: "2026-10-01", to: "2026-10-31" },
        "America/Sao_Paulo",
      ),
    ).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      start: new Date("2026-10-01T03:00:00.000Z"),
      end: new Date("2026-11-01T03:00:00.000Z"),
    });
  });

  it("is every date without a period", () => {
    expect(deliveryPeriodWindow({}, "America/Sao_Paulo")).toBeNull();
  });
});

describe("the querystring", () => {
  const parse = (query: Record<string, string>) =>
    listDeliverySchema.safeParse({ page: "1", pageSize: "10", ...query });

  const messages = (query: Record<string, string>) => {
    const result = parse(query);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it("takes no period, a preset, or a custom range of up to 92 days", () => {
    expect(parse({}).success).toBe(true);
    for (const period of ["today", "7d", "14d", "30d"]) {
      expect(parse({ period }).success).toBe(true);
    }
    // 01/08 to 31/10: exactly 92 days.
    expect(
      parse({ period: "custom", from: "2026-08-01", to: "2026-10-31" }).success,
    ).toBe(true);
  });

  it("refuses, in Portuguese, what it cannot read", () => {
    expect(messages({ period: "ontem" })).toEqual([
      "Período inválido. Use: today, 7d, 14d, 30d, custom.",
    ]);
    expect(messages({ period: "custom", from: "2026-10-01" })).toEqual([
      "No período personalizado, informe a data inicial (from) e a final (to), no formato AAAA-MM-DD.",
    ]);
    expect(messages({ period: "today", from: "2026-10-01" })).toEqual([
      "As datas do período (from e to) só valem com period=custom.",
    ]);
    expect(
      messages({ period: "custom", from: "2026-10-10", to: "2026-10-01" }),
    ).toEqual(["A data inicial do período não pode ser depois da data final."]);
    expect(
      messages({ period: "custom", from: "2026-02-30", to: "2026-03-01" }),
    ).toEqual(["A data inicial do período não é uma data válida."]);
    expect(
      messages({ period: "custom", from: "01/10/2026", to: "2026-10-02" }),
    ).toEqual(["A data inicial do período deve estar no formato AAAA-MM-DD."]);
  });

  it("caps the custom range at 92 days, and the export takes the same rules", () => {
    const tooLong = { period: "custom", from: "2026-07-31", to: "2026-10-31" };

    expect(messages(tooLong)).toEqual([
      "O período personalizado pode ter no máximo 92 dias. Para um intervalo maior, exporte por partes.",
    ]);
    expect(exportDeliverySchema.safeParse(tooLong).success).toBe(false);
    expect(
      exportDeliverySchema.safeParse({ period: "today", kind: "SERVICE_ORDER" })
        .success,
    ).toBe(true);
  });

  it("takes the type filter over the three kinds", () => {
    const parsed = parse({ kind: "SERVICE_ORDER,PICKUP" });

    expect(parsed.success && parsed.data.kind).toEqual([
      "SERVICE_ORDER",
      "PICKUP",
    ]);
    expect(messages({ kind: "ORDEM" })[0]).toMatch(/Valor de filtro inválido/);
  });
});

describe("the list with a period", () => {
  it("lists today's deliveries only, and the cards and the pager count only them", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      period: "today",
    });

    expect(ids(result)).toEqual(["today-1", "today-2"]);
    expect(result.total).toBe(2);
    expect(result.meta?.statusCounts).toEqual({ PENDING: 1, DELIVERED: 1 });
    expect(result.meta?.facets.shipperId).toEqual([
      { value: SHIPPER, label: "Atacado Sul", count: 2 },
    ]);
    expect(result.meta?.period).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
      applied: true,
    });
  });

  it("lists every date without one, as before the period existed", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(5);
    expect(result.meta?.period).toBeNull();
  });

  it("covers the last seven days with 7d", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      period: "7d",
    });

    expect(ids(result)).toEqual(
      ["five-days", "late-yesterday", "today-1", "today-2"].sort(),
    );
  });

  it("filters by type, inside the period", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      period: "today",
      kinds: ["SERVICE_ORDER"],
    });

    expect(ids(result)).toEqual(["today-2"]);
    expect(result.data[0]).toMatchObject({ kind: "SERVICE_ORDER" });
  });
});

describe("an exact search ignores the period", () => {
  // The notification's link: /entregas?search=<id> (delivery-occurrence-
  // policy). The screen sends period=today; the delivery is forty days old.
  it("finds an old delivery by its id, and says the period was set aside", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      period: "today",
      search: OLD_ID,
    });

    expect(ids(result)).toEqual([OLD_ID]);
    expect(result.total).toBe(1);
    expect(result.meta?.period).toMatchObject({ applied: false });
  });

  it("finds it by its order code or NF number too, case-insensitively", async () => {
    const { list } = build();

    const run = (search: string) =>
      list.execute({
        userId: MANAGER,
        page: 1,
        pageSize: 10,
        period: "today",
        search,
      });

    expect(ids(await run("45515"))).toEqual([OLD_ID]);
    // Only the period is set aside: the term still searches as it always
    // did, so today's PED-10 (which contains "ped-1") comes along.
    expect(ids(await run("ped-1"))).toEqual([OLD_ID, "today-1"].sort());
  });

  it("keeps a partial term inside the period", async () => {
    const { list } = build();

    // "PED-1" is a prefix of today's PED-10, and "Cliente" is everywhere:
    // neither is a document's identity.
    const partial = await list.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
      period: "today",
      search: "Cliente",
    });

    expect(ids(partial)).toEqual(["today-1", "today-2"]);
    expect(partial.meta?.period).toMatchObject({ applied: true });
  });

  it("does not widen a driver's scope: another driver's document stays out", async () => {
    const { list } = build();

    const result = await list.execute({
      userId: DRIVER_USER,
      page: 1,
      pageSize: 10,
      period: "today",
      search: OLD_ID,
    });

    expect(result.data).toEqual([]);
    expect(result.meta?.period).toMatchObject({ applied: true });
  });

  it("applies to the export the same way, with the type in Portuguese", async () => {
    const { exporter } = build();

    const rows = async (input: Record<string, unknown>) => {
      const { iterator } = await exporter.execute({
        userId: MANAGER,
        ...input,
      });
      const out: Array<Record<string, unknown>> = [];
      for await (const row of iterator) out.push(row);
      return out;
    };

    expect(
      (await rows({ period: "today" })).map((row) => [row.id, row.kind]),
    ).toEqual([
      ["today-1", "Entrega"],
      ["today-2", "Ordem de serviço"],
    ]);
    expect(
      (await rows({ period: "today", search: OLD_ID })).map((row) => row.id),
    ).toEqual([OLD_ID]);
  });

  it("puts a Tipo column in the file", async () => {
    const { exporter } = build();

    const { columns } = await exporter.execute({ userId: MANAGER });

    expect(columns.map((column) => column.header)).toContain("Tipo");
  });
});

describe("the single-scan count shortcut", () => {
  // The repository rebuilds the tenant, the scope and the period in its
  // GROUPING SETS read; any other filter must turn the shortcut off.
  it("keeps the shortcut with a period and turns it off with a type", () => {
    const period = {
      businessId: BUSINESS,
      createdFrom: new Date("2026-10-28T03:00:00.000Z"),
      createdTo: new Date("2026-10-29T03:00:00.000Z"),
    };

    expect(isTenantOnlyDeliveryList(period)).toBe(true);
    expect(isTenantOnlyDeliveryList({ ...period, kinds: ["DELIVERY"] })).toBe(
      false,
    );
    expect(deliveryListWhere(period)).toEqual({
      businessId: BUSINESS,
      AND: [
        {
          created_at: {
            gte: period.createdFrom,
            lt: period.createdTo,
          },
        },
      ],
    });
  });
});
