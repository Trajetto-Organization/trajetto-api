import { beforeEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidV7 } from "uuid";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";
import type {
  CreateServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
  ServiceOrderPart,
  UpdateServiceOrderPart,
} from "@/modules/service-order-part/dtos/service-order-part-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryPartRepository } from "@/modules/part/repositories/in-memory/in-memory-part-repository";
import { partsTotalOf } from "@/modules/service-order/usecases/list-service-order/service-order-list";

import { CreateServiceOrderPartUseCase } from "@/modules/service-order-part/usecases/create-service-order-part/create-service-order-part-usecase";
import { UpdateServiceOrderPartUseCase } from "@/modules/service-order-part/usecases/update-service-order-part/update-service-order-part-usecase";
import { DeleteServiceOrderPartUseCase } from "@/modules/service-order-part/usecases/delete-service-order-part/delete-service-order-part-usecase";
import { ListServiceOrderPartUseCase } from "@/modules/service-order-part/usecases/list-service-order-part/list-service-order-part-usecase";

/**
 * Service order lines (TEST-UC-1). The module has no in-memory twin, so the
 * store below keeps only what the use cases read: lines by id, the
 * (order, part) lookup and the order's totals. The rules under test — tenant,
 * the line belonging to the order in the path, duplicates, the catalogue price
 * fallback — are the use cases' own. The SQL side is in
 * tests/E2E/service-order-part-*.test.ts.
 */
class ServiceOrderPartStore implements IServiceOrderPartRepository {
  public lines: ServiceOrderPart[] = [];
  public failWrites = false;
  public lastList: ListServiceOrderPartByBusinessIdProps | null = null;

  constructor(private orders: InMemoryServiceOrderRepository) {}

  async createServiceOrderPart(data: CreateServiceOrderPartProps) {
    if (this.failWrites) throw new Error("connection reset");

    const now = new Date();
    const line: ServiceOrderPart = {
      id: uuidV7(),
      unit_price: String(data.unit_price),
      quantity: data.quantity,
      discount_percentage:
        data.discount_percentage == null ? null : String(data.discount_percentage),
      businessId: data.businessId,
      serviceOrderId: data.serviceOrderId,
      partId: data.partId,
      created_at: now,
      updated_at: now,
    };

    this.lines.push(line);
    return line;
  }

  async listServiceOrderParts(props: ListServiceOrderPartByBusinessIdProps) {
    this.lastList = props;

    const data = this.lines.filter((line) => line.businessId === props.businessId);

    return {
      data,
      aggregate: {
        count: data.length,
        withDiscount: data.filter((line) => Number(line.discount_percentage ?? 0) > 0)
          .length,
        // price × quantity × (1 − discount), like the repository's SQL.
        totalValue: partsTotalOf(data),
      },
      partCounts: [],
    };
  }

  async updateServiceOrderPart({ serviceOrderPartData, serviceOrderPartId }: UpdateServiceOrderPart) {
    if (this.failWrites) throw new Error("connection reset");

    const line = this.lines.find((entry) => entry.id === serviceOrderPartId);
    if (!line) throw new Error("P2025");

    Object.assign(line, {
      ...(serviceOrderPartData.unit_price !== undefined && {
        unit_price: String(serviceOrderPartData.unit_price),
      }),
      ...(serviceOrderPartData.quantity !== undefined && {
        quantity: serviceOrderPartData.quantity,
      }),
      // Prisma writes every defined field, discount included (null clears it).
      ...(serviceOrderPartData.discount_percentage !== undefined && {
        discount_percentage:
          serviceOrderPartData.discount_percentage == null
            ? null
            : String(serviceOrderPartData.discount_percentage),
      }),
      ...(serviceOrderPartData.partId && { partId: serviceOrderPartData.partId }),
      ...(serviceOrderPartData.serviceOrderId && {
        serviceOrderId: serviceOrderPartData.serviceOrderId,
      }),
      ...(serviceOrderPartData.businessId && {
        businessId: serviceOrderPartData.businessId,
      }),
    });

    return line;
  }

  async deleteServiceOrderPart(serviceOrderPartId: string) {
    if (this.failWrites) throw new Error("connection reset");

    const index = this.lines.findIndex((entry) => entry.id === serviceOrderPartId);
    if (index < 0) throw new Error("P2025");

    return this.lines.splice(index, 1)[0];
  }

  async findServiceOrderPartById(serviceOrderPartId: string) {
    return this.lines.find((entry) => entry.id === serviceOrderPartId) ?? null;
  }

  async findServiceOrderPartByPartId(partId: string, serviceOrderId: string) {
    return (
      this.lines.find(
        (entry) => entry.partId === partId && entry.serviceOrderId === serviceOrderId,
      ) ?? null
    );
  }

  async calculateServiceOrderTotal(serviceOrderId: string) {
    // The discount counts, as in ServiceOrderPartRepository.
    return partsTotalOf(this.lines.filter((entry) => entry.serviceOrderId === serviceOrderId));
  }

  async serviceOrderTotals(serviceOrderId: string) {
    const order = await this.orders.findServiceOrderById(serviceOrderId);
    if (!order) return null;

    return {
      totalAmount: Number(order.total_amount ?? 0),
      partsTotal: await this.calculateServiceOrderTotal(serviceOrderId),
    };
  }
}

const CARRIER = "018f3000-0000-7000-8000-00000000000a";
const OTHER = "018f3000-0000-7000-8000-00000000000b";

const ADMIN = "018f3000-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018f3000-0000-7000-8000-0000000000a2";
const MASTER = "018f3000-0000-7000-8000-0000000000a3";

const ORDER = "018f3000-0000-7000-8000-0000000000c1";
const SECOND_ORDER = "018f3000-0000-7000-8000-0000000000c2";
const FOREIGN_ORDER = "018f3000-0000-7000-8000-0000000000c3";

const notifications = {
  createActivityIfEnabled: vi.fn(),
} as unknown as NotificationService;

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let orders: InMemoryServiceOrderRepository;
let parts: InMemoryPartRepository;
let lines: ServiceOrderPartStore;

let filter: string;
let foreignFilter: string;
let brakePad: string;

beforeEach(async () => {
  vi.mocked(notifications.createActivityIfEnabled).mockClear();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  orders = new InMemoryServiceOrderRepository();
  parts = new InMemoryPartRepository();
  lines = new ServiceOrderPartStore(orders);

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push({ id: CARRIER } as Business, { id: OTHER } as Business);

  orders.serviceOrders.push(
    { id: ORDER, businessId: CARRIER, total_amount: "500" } as unknown as ServiceOrder,
    { id: SECOND_ORDER, businessId: CARRIER, total_amount: "100" } as unknown as ServiceOrder,
    { id: FOREIGN_ORDER, businessId: OTHER, total_amount: "300" } as unknown as ServiceOrder,
  );

  filter = (
    await parts.createPart({
      description: "Filtro de óleo",
      unit_price: 45.9,
      businessId: CARRIER,
    } as never)
  ).id;
  brakePad = (
    await parts.createPart({
      description: "Pastilha de freio",
      unit_price: 180,
      businessId: CARRIER,
    } as never)
  ).id;
  foreignFilter = (
    await parts.createPart({
      description: "Filtro de ar",
      unit_price: 60,
      businessId: OTHER,
    } as never)
  ).id;
});

const create = () =>
  new CreateServiceOrderPartUseCase(users, businesses, orders, parts, lines, notifications);
const update = () =>
  new UpdateServiceOrderPartUseCase(users, businesses, orders, parts, lines, notifications);
const remove = () =>
  new DeleteServiceOrderPartUseCase(users, businesses, orders, lines, notifications);
const list = () => new ListServiceOrderPartUseCase(users, lines);

const lineOf = (overrides: Partial<CreateServiceOrderPartProps> = {}) => ({
  unit_price: 50,
  quantity: 2,
  businessId: CARRIER,
  serviceOrderId: ORDER,
  partId: filter,
  ...overrides,
});

describe("adding a part to a service order", () => {
  it("stores the line and answers the order's typed total beside the parts total", async () => {
    const { line, totals } = await create().execute(lineOf(), ADMIN);

    expect(line).toMatchObject({ serviceOrderId: ORDER, partId: filter, quantity: 2 });
    expect(totals).toEqual({ totalAmount: 500, partsTotal: 100 });
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", businessId: CARRIER, performedBy: ADMIN }),
    );
  });

  it("counts the line's discount in the parts total, and keeps an edited one", async () => {
    // The fake summed price × quantity only, where the repository applies
    // (1 − discount): a total the screen never shows.
    const { line, totals } = await create().execute(lineOf({ discount_percentage: 10 }), ADMIN);

    expect(totals).toEqual({ totalAmount: 500, partsTotal: 90 });

    const result = await update().execute(
      { discount_percentage: 50 } as never,
      line.id,
      ORDER,
      CARRIER,
      ADMIN,
    );

    expect(result.totals?.partsTotal).toBe(50);
  });

  it("falls back to the catalogue price when none is typed", async () => {
    const { line } = await create().execute(
      lineOf({ unit_price: undefined as unknown as number }),
      ADMIN,
    );

    expect(Number(line.unit_price)).toBe(45.9);
  });

  it("refuses the same part twice on one order with a 409, and keeps one line", async () => {
    await create().execute(lineOf(), ADMIN);

    await expect(create().execute(lineOf({ quantity: 5 }), ADMIN)).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_ORDER_PART_ALREADY_EXISTS",
    });
    expect(lines.lines).toHaveLength(1);
  });

  it("lets the same part go on a different order", async () => {
    await create().execute(lineOf(), ADMIN);
    await create().execute(lineOf({ serviceOrderId: SECOND_ORDER }), ADMIN);

    expect(lines.lines).toHaveLength(2);
  });

  it("answers another company's order as absent (404), never as 'not yours'", async () => {
    await expect(
      create().execute(lineOf({ serviceOrderId: FOREIGN_ORDER }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" });
    expect(lines.lines).toHaveLength(0);
  });

  it("answers another company's part as absent (404)", async () => {
    await expect(
      create().execute(lineOf({ partId: foreignFilter }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "PART_NOT_FOUND" });
  });

  it("refuses an unknown caller and an unknown company", async () => {
    await expect(create().execute(lineOf(), uuidV7())).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    await expect(
      create().execute(lineOf({ businessId: uuidV7() }), ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("turns a storage failure into a 500 with a sentence", async () => {
    lines.failWrites = true;

    await expect(create().execute(lineOf(), ADMIN)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe("editing a service order line", () => {
  it("changes quantity and price and answers the new totals", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);

    const result = await update().execute(
      { quantity: 3, unit_price: 200 },
      line.id,
      ORDER,
      CARRIER,
      ADMIN,
    );

    expect(result.line).toMatchObject({ quantity: 3 });
    expect(result.totals).toEqual({ totalAmount: 500, partsTotal: 600 });
  });

  it("keeps its own part when the same part is sent again", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);

    await expect(
      update().execute({ partId: filter, quantity: 1 }, line.id, ORDER, CARRIER, ADMIN),
    ).resolves.toMatchObject({ line: { quantity: 1 } });
  });

  it("refuses swapping to a part already on the order (409)", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);
    await create().execute(lineOf({ partId: brakePad }), ADMIN);

    await expect(
      update().execute({ partId: brakePad }, line.id, ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "SERVICE_ORDER_PART_ALREADY_EXISTS" });
  });

  it("refuses a line of another order: it is not found from this order's path", async () => {
    const { line } = await create().execute(lineOf({ serviceOrderId: SECOND_ORDER }), ADMIN);

    await expect(
      update().execute({ quantity: 9 }, line.id, ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVICE_ORDER_PART_NOT_FOUND" });

    // Nothing moved: the line is still on its own order with its quantity.
    expect(lines.lines[0]).toMatchObject({ serviceOrderId: SECOND_ORDER, quantity: 2 });
  });

  it("refuses another company's line reached through its own order (cross-tenant)", async () => {
    const foreign = await create().execute(
      lineOf({ businessId: OTHER, serviceOrderId: FOREIGN_ORDER, partId: foreignFilter }),
      OTHER_ADMIN,
    );

    await expect(
      update().execute({ quantity: 9 }, foreign.line.id, FOREIGN_ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" });

    await expect(
      update().execute({ quantity: 9 }, foreign.line.id, ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVICE_ORDER_PART_NOT_FOUND" });

    expect(lines.lines[0]).toMatchObject({ businessId: OTHER, quantity: 2 });
  });

  it("refuses a part of another company in the body (404)", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);

    await expect(
      update().execute({ partId: foreignFilter }, line.id, ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "PART_NOT_FOUND" });
  });

  it("turns a storage failure into a 500", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);
    lines.failWrites = true;

    await expect(
      update().execute({ quantity: 4 }, line.id, ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("removing a service order line", () => {
  it("deletes the line of this order", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);

    await remove().execute(line.id, ORDER, CARRIER, ADMIN);

    expect(lines.lines).toHaveLength(0);
    expect(notifications.createActivityIfEnabled).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "delete", entityId: line.id }),
    );
  });

  it("refuses a line of another order, and keeps it", async () => {
    const { line } = await create().execute(lineOf({ serviceOrderId: SECOND_ORDER }), ADMIN);

    await expect(remove().execute(line.id, ORDER, CARRIER, ADMIN)).rejects.toMatchObject({
      statusCode: 404,
      code: "SERVICE_ORDER_PART_NOT_FOUND",
    });
    expect(lines.lines).toHaveLength(1);
  });

  it("refuses another company's order (cross-tenant), and keeps its line", async () => {
    const foreign = await create().execute(
      lineOf({ businessId: OTHER, serviceOrderId: FOREIGN_ORDER, partId: foreignFilter }),
      OTHER_ADMIN,
    );

    await expect(
      remove().execute(foreign.line.id, FOREIGN_ORDER, CARRIER, ADMIN),
    ).rejects.toMatchObject({ statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" });
    expect(lines.lines).toHaveLength(1);
  });

  it("turns a storage failure into a 500", async () => {
    const { line } = await create().execute(lineOf(), ADMIN);
    lines.failWrites = true;

    await expect(remove().execute(line.id, ORDER, CARRIER, ADMIN)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe("listing service order lines", () => {
  it("pins a company user to their own company and summarizes the cards", async () => {
    await create().execute(lineOf(), ADMIN);
    await create().execute(lineOf({ partId: brakePad, unit_price: 100, quantity: 1 }), ADMIN);

    const result = await list().execute({ userId: ADMIN, page: 1, pageSize: 10 });

    expect(lines.lastList?.businessId).toBe(CARRIER);
    expect(result.total).toBe(2);
    expect(result.searchMeta).toMatchObject({ total: 2, totalValue: 200, averageValue: 100 });
  });

  it("refuses a company user naming another company (403 TENANT_ACCESS_DENIED)", async () => {
    await expect(
      list().execute({ userId: ADMIN, businessId: OTHER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(lines.lastList).toBeNull();
  });

  it("asks the MASTER to pick a company (400) and serves the one picked", async () => {
    await expect(
      list().execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BUSINESS_NOT_IDENTIFIED" });

    await list().execute({ userId: MASTER, businessId: OTHER, page: 1, pageSize: 10 });
    expect(lines.lastList?.businessId).toBe(OTHER);
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      list().execute({ userId: uuidV7(), page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});
