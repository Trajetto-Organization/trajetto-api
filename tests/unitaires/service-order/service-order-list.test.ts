import { describe, expect, it } from "vitest";

import {
  partsTotalOf,
  serviceOrderListWhere,
  summarizeServiceOrderList,
  type ServiceOrderTypeCount,
} from "@/modules/service-order/usecases/list-service-order/service-order-list";

import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";

/**
 * The service order list's rules without a database: the where the
 * repository sends, the disjunctive summary the cards read, the parts total
 * the warning compares, and the twin answering like Postgres does
 * (tests/E2E/service-order-list-http.test.ts pins the real one on the same
 * scenario).
 */

const COMPANY = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

describe("serviceOrderListWhere", () => {
  it("keeps the tenant at the top, outside every OR", () => {
    const where = serviceOrderListWhere({ businessId: COMPANY, search: "abc" });

    expect(where.businessId).toBe(COMPANY);
    expect(JSON.stringify(where.AND)).not.toContain(COMPANY);
  });

  it("filters one status, and treats both as no filter", () => {
    expect(
      serviceOrderListWhere({ businessId: COMPANY, statuses: ["open"] }).AND,
    ).toEqual([{ completion_date: null }]);

    expect(
      serviceOrderListWhere({ businessId: COMPANY, statuses: ["completed"] }).AND,
    ).toEqual([{ completion_date: { not: null } }]);

    expect(
      serviceOrderListWhere({ businessId: COMPANY, statuses: ["open", "completed"] }),
    ).toEqual({ businessId: COMPANY });
  });

  it("leaves out the facets it is asked to count", () => {
    const where = serviceOrderListWhere(
      {
        businessId: COMPANY,
        statuses: ["open"],
        maintenanceTypes: ["INTERNAL"],
        branchIds: ["b1"],
      },
      { except: ["status", "maintenanceType"] },
    );

    expect(where.AND).toEqual([{ branchId: { in: ["b1"] } }]);
  });

  it("escapes the search term: % and _ are characters", () => {
    const where = serviceOrderListWhere({ businessId: COMPANY, search: "50%" });

    expect(JSON.stringify(where)).toContain("50\\\\%");
  });
});

describe("summarizeServiceOrderList", () => {
  const cells: ServiceOrderTypeCount[] = [
    { status: "open", maintenance_type: "INTERNAL", count: 4, totalAmount: 640 },
    { status: "open", maintenance_type: "EXTERNAL", count: 4, totalAmount: 680 },
    { status: "completed", maintenance_type: "INTERNAL", count: 2, totalAmount: 260 },
    { status: "completed", maintenance_type: "EXTERNAL", count: 2, totalAmount: 320 },
  ];

  it("counts each facet with the others applied and never itself", () => {
    const { total, searchMeta } = summarizeServiceOrderList(cells, [], {
      statuses: ["open"],
      maintenanceTypes: ["INTERNAL"],
    });

    expect(total).toBe(4);
    expect(searchMeta).toMatchObject({ total: 6, open: 4, completed: 2, totalAmount: 640 });
    expect(searchMeta.facets.status).toEqual([
      { value: "open", count: 4 },
      { value: "completed", count: 2 },
    ]);
    expect(searchMeta.facets.maintenanceType).toEqual([
      { value: "INTERNAL", count: 4 },
      { value: "EXTERNAL", count: 4 },
    ]);
  });

  it("without filters, the cards are the whole company and add up", () => {
    const { total, searchMeta } = summarizeServiceOrderList(cells, [], {});

    expect(total).toBe(12);
    expect(searchMeta.open + searchMeta.completed).toBe(searchMeta.total);
    expect(searchMeta.totalAmount).toBe(1900);
  });
});

describe("partsTotalOf", () => {
  it("applies each line's discount and rounds to cents", () => {
    expect(
      partsTotalOf([
        { unit_price: "100", quantity: 2, discount_percentage: "10" },
        { unit_price: 50, quantity: 1, discount_percentage: null },
        { unit_price: "0.335", quantity: 1 },
      ]),
    ).toBe(230.34);
  });
});

describe("InMemoryServiceOrderRepository.listServiceOrders", () => {
  function scenario(): InMemoryServiceOrderRepository {
    const repository = new InMemoryServiceOrderRepository();
    const base = Date.UTC(2026, 8, 20, 12);

    repository.vehicles.set("v1", { license_plate: "PQR1S11", description: "Caminhão 1" });
    repository.vehicles.set("v2", { license_plate: "TUV2W22", description: "Caminhão 2" });
    repository.branchNames.set("centro", "Filial Centro");
    repository.branchNames.set("norte", "Filial Norte");

    for (let index = 0; index < 12; index += 1) {
      const created = new Date(base + index * 5 * 60_000);

      repository.serviceOrders.push({
        id: `018f0000-0000-7000-8000-0000000000${String(index).padStart(2, "0")}`,
        description: `OS-${String(index).padStart(2, "0")}`,
        date: created,
        completion_date: index % 3 === 0 ? created : null,
        maintenance_type: index % 2 === 0 ? "INTERNAL" : "EXTERNAL",
        total_amount: String(100 + index * 10),
        businessId: COMPANY,
        vehicleId: index % 2 === 0 ? "v1" : "v2",
        responsibleUserId: "u1",
        branchId: index < 8 ? "centro" : "norte",
        supplierId: null,
        created_from: "WEB_DASHBOARD",
        created_at: created,
        updated_at: created,
      } as ServiceOrder);
    }

    repository.serviceOrders.push({
      ...repository.serviceOrders[0],
      id: "018f0000-0000-7000-8000-0000000000ff",
      description: "OS Secreta",
      businessId: OTHER,
    });

    return repository;
  }

  const descriptions = (rows: Array<{ description?: string | null }>) =>
    rows.map((row) => row.description);

  it("answers the E2E scenario like Postgres: order, NULLs, paging", async () => {
    const repository = scenario();

    const page = await repository.listServiceOrders({ businessId: COMPANY, page: 1, pageSize: 10 });

    expect(descriptions(page.data).slice(0, 2)).toEqual(["OS-11", "OS-10"]);

    const byPlate = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      sort: "vehicleLicensePlate",
      order: "asc",
    });

    expect(descriptions(byPlate.data).slice(0, 3)).toEqual(["OS-10", "OS-08", "OS-06"]);

    const byCompletion = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      sort: "completion_date",
      order: "asc",
    });

    expect(descriptions(byCompletion.data).slice(0, 4)).toEqual([
      "OS-00", "OS-03", "OS-06", "OS-09",
    ]);
    expect(byCompletion.data[4].completion_date).toBeNull();

    const second = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 2,
      pageSize: 10,
      sort: "total_amount",
      order: "asc",
    });

    expect(descriptions(second.data)).toEqual(["OS-10", "OS-11"]);
  });

  it("gives the same cells and branch options the real one gives", async () => {
    const repository = scenario();

    const result = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      statuses: ["open"],
      maintenanceTypes: ["INTERNAL"],
    });

    const { total, searchMeta } = summarizeServiceOrderList(result.cells, result.branchCounts, {
      statuses: ["open"],
      maintenanceTypes: ["INTERNAL"],
    });

    expect(total).toBe(4);
    expect(result.data).toHaveLength(4);
    expect(searchMeta).toMatchObject({ total: 6, open: 4, completed: 2, totalAmount: 640 });

    const byBranch = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      branchIds: ["norte"],
    });

    expect(byBranch.branchCounts).toEqual([
      { value: "centro", label: "Filial Centro", count: 8 },
      { value: "norte", label: "Filial Norte", count: 4 },
    ]);
  });

  it("never lists another company's order, even when searched", async () => {
    const repository = scenario();

    const result = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 10,
      search: "secreta",
    });

    expect(result.data).toEqual([]);
  });

  it("finds by plate and by the amount as the screen writes it", async () => {
    const repository = scenario();

    const byPlate = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 20,
      search: "tuv2",
    });

    expect(byPlate.data).toHaveLength(6);

    const byAmount = await repository.listServiceOrders({
      businessId: COMPANY,
      page: 1,
      pageSize: 20,
      search: "150,00",
    });

    expect(descriptions(byAmount.data)).toEqual(["OS-05"]);
  });
});
