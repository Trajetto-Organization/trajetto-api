import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import { CreateShipperUseCase } from "@/modules/shipper/usecases/create-shipper/create-shipper-usecase";
import { UpdateShipperUseCase } from "@/modules/shipper/usecases/update-shipper/update-shipper-usecase";
import { DeleteShipperUseCase } from "@/modules/shipper/usecases/delete-shipper/delete-shipper-usecase";

import { CreateStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/create-status-change-reason/create-status-change-reason-usecase";
import { UpdateStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/update-status-change-reason/update-status-change-reason-usecase";
import { DeleteStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/delete-status-change-reason/delete-status-change-reason-usecase";

/**
 * Two catalogues of the operation (TEST-UC-1): shippers and status change
 * reasons. Both belong to the dispatcher (never the driver), are per company
 * (another company's id reads as absent), keep their history (in-use rows are
 * refused, not deleted) and answer a race on the unique index like the check.
 * The websocket is the replaced boundary (catalogChanged emission is covered
 * by tests/unitaires/delivery/catalog-changed.test.ts).
 */
vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: () => undefined,
}));

const CARRIER = "018f3900-0000-7000-8000-00000000000a";
const OTHER = "018f3900-0000-7000-8000-00000000000b";

const DISPATCHER = "018f3900-0000-7000-8000-0000000000a1";
const OTHER_DISPATCHER = "018f3900-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f3900-0000-7000-8000-0000000000a4";
const UNKNOWN = "018f3900-0000-7000-8000-0000000000ff";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let shippers: InMemoryShipperRepository;
let reasons: InMemoryStatusChangeReasonRepository;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  shippers = new InMemoryShipperRepository();
  reasons = new InMemoryStatusChangeReasonRepository();

  users.user.push(
    {
      id: DISPATCHER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
    } as User,
    {
      id: OTHER_DISPATCHER,
      role: "BUSINESS_ADMIN",
      businessId: OTHER,
      driverId: null,
    } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "018f3900-0000-7000-8000-0000000000d1",
    } as User,
  );
  businesses.business.push(
    { id: CARRIER } as Business,
    { id: OTHER } as Business,
  );
});

describe("shippers", () => {
  const create = () => new CreateShipperUseCase(users, businesses, shippers);
  const update = () => new UpdateShipperUseCase(users, shippers);
  const remove = () => new DeleteShipperUseCase(users, shippers);

  const shipperOf = (overrides: Record<string, unknown> = {}) => ({
    name: "Loja Centro",
    cnpj: "11222333000181",
    businessId: CARRIER,
    ...overrides,
  });

  it("creates a shipper for the company", async () => {
    const created = await create().execute(shipperOf(), DISPATCHER);

    expect(created).toMatchObject({
      name: "Loja Centro",
      businessId: CARRIER,
      is_active: true,
    });
  });

  it("refuses a driver, whatever the permission table says (403)", async () => {
    await expect(
      create().execute(shipperOf(), DRIVER_USER),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_MANAGE_DELIVERIES",
    });
    expect(shippers.shippers).toHaveLength(0);
  });

  it("refuses a name in any case and a CNPJ already in the company (409), not in another", async () => {
    await create().execute(shipperOf(), DISPATCHER);

    await expect(
      create().execute(
        shipperOf({ name: "LOJA CENTRO", cnpj: null }),
        DISPATCHER,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_NAME_TAKEN" });

    await expect(
      create().execute(shipperOf({ name: "Loja Norte" }), DISPATCHER),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_CNPJ_TAKEN" });

    await expect(
      create().execute(shipperOf({ businessId: OTHER }), OTHER_DISPATCHER),
    ).resolves.toMatchObject({ businessId: OTHER });
  });

  it("answers a twin request that won the race on the index with the same 409", async () => {
    await create().execute(shipperOf(), DISPATCHER);

    // The check saw nothing (the twin committed right after it); the unique
    // index decides, and the answer must not be a 500.
    shippers.findShipperByName = async () => null;
    shippers.findShipperByCnpj = async () => null;

    await expect(
      create().execute(shipperOf({ name: "Loja Norte" }), DISPATCHER),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_CNPJ_TAKEN" });

    await expect(
      create().execute(shipperOf({ cnpj: null }), DISPATCHER),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_NAME_TAKEN" });

    expect(shippers.shippers).toHaveLength(1);
  });

  it("refuses an unknown caller and an unknown company (404)", async () => {
    await expect(create().execute(shipperOf(), UNKNOWN)).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });

    await expect(
      create().execute(shipperOf({ businessId: UNKNOWN }), DISPATCHER),
    ).rejects.toMatchObject({ statusCode: 404, code: "TENANT_NOT_FOUND" });
  });

  it("edits, keeping its own name and CNPJ, and deactivates", async () => {
    const created = await create().execute(shipperOf(), DISPATCHER);

    const updated = await update().execute({
      userId: DISPATCHER,
      businessId: CARRIER,
      shipperId: created.id as string,
      shipperData: {
        name: "Loja Centro",
        cnpj: "11222333000181",
        is_active: false,
      } as never,
    });

    expect(updated.is_active).toBe(false);
  });

  it("lets an edit change only the case of its own name", async () => {
    const created = await create().execute(shipperOf(), DISPATCHER);

    await expect(
      update().execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        shipperId: created.id as string,
        shipperData: { name: "LOJA CENTRO" },
      }),
    ).resolves.toMatchObject({ name: "LOJA CENTRO" });
  });

  it("refuses renaming onto another shipper's name (409)", async () => {
    await create().execute(shipperOf(), DISPATCHER);
    const second = await create().execute(
      shipperOf({ name: "Loja Norte", cnpj: null }),
      DISPATCHER,
    );

    await expect(
      update().execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        shipperId: second.id as string,
        shipperData: { name: "loja centro" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_NAME_TAKEN" });
  });

  it("answers another company's shipper as absent on edit and delete (404), and keeps it", async () => {
    const foreign = await create().execute(
      shipperOf({ businessId: OTHER }),
      OTHER_DISPATCHER,
    );

    await expect(
      update().execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        shipperId: foreign.id as string,
        shipperData: { name: "Tomada" },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SHIPPER_NOT_FOUND" });

    await expect(
      remove().execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        shipperId: foreign.id as string,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SHIPPER_NOT_FOUND" });

    expect(shippers.shippers[0]).toMatchObject({
      name: "Loja Centro",
      businessId: OTHER,
    });
  });

  it("refuses deleting a shipper with deliveries (409) and deletes one without", async () => {
    const created = await create().execute(shipperOf(), DISPATCHER);
    shippers.deliveryCounts.set(created.id as string, 3);

    await expect(
      remove().execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        shipperId: created.id as string,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SHIPPER_HAS_DELIVERIES",
    });

    shippers.deliveryCounts.delete(created.id as string);
    await remove().execute({
      userId: DISPATCHER,
      businessId: CARRIER,
      shipperId: created.id as string,
    });

    expect(shippers.shippers).toHaveLength(0);
  });

  it("refuses a driver on edit and delete (403)", async () => {
    const created = await create().execute(shipperOf(), DISPATCHER);

    await expect(
      update().execute({
        userId: DRIVER_USER,
        businessId: CARRIER,
        shipperId: created.id as string,
        shipperData: { name: "X" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      remove().execute({
        userId: DRIVER_USER,
        businessId: CARRIER,
        shipperId: created.id as string,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(shippers.shippers).toHaveLength(1);
  });
});

describe("status change reasons", () => {
  const create = () =>
    new CreateStatusChangeReasonUseCase(users, businesses, reasons);
  const update = () => new UpdateStatusChangeReasonUseCase(users, reasons);
  const remove = () => new DeleteStatusChangeReasonUseCase(users, reasons);

  const reasonOf = (overrides: Record<string, unknown> = {}) => ({
    name: "Cliente reagendou",
    businessId: CARRIER,
    ...overrides,
  });

  it("creates a reason and refuses the same name in the company (409), not in another", async () => {
    const created = await create().execute(reasonOf() as never, DISPATCHER);
    expect(created).toMatchObject({
      name: "Cliente reagendou",
      businessId: CARRIER,
    });

    await expect(
      create().execute(reasonOf() as never, DISPATCHER),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STATUS_CHANGE_REASON_NAME_TAKEN",
    });

    await expect(
      create().execute(
        reasonOf({ businessId: OTHER }) as never,
        OTHER_DISPATCHER,
      ),
    ).resolves.toMatchObject({ businessId: OTHER });
  });

  it("answers a race on the unique index with the same 409", async () => {
    await create().execute(reasonOf() as never, DISPATCHER);
    reasons.findStatusChangeReasonByName = async () => null;

    await expect(
      create().execute(reasonOf() as never, DISPATCHER),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STATUS_CHANGE_REASON_NAME_TAKEN",
    });
  });

  it("refuses a driver (403) and an unknown company (404)", async () => {
    await expect(
      create().execute(reasonOf() as never, DRIVER_USER),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_MANAGE_DELIVERIES",
    });

    await expect(
      create().execute(reasonOf({ businessId: UNKNOWN }) as never, DISPATCHER),
    ).rejects.toMatchObject({ statusCode: 404, code: "TENANT_NOT_FOUND" });
  });

  it("renames, keeps its own name, and refuses another reason's name (409)", async () => {
    const first = await create().execute(reasonOf() as never, DISPATCHER);
    const second = await create().execute(
      reasonOf({ name: "Endereço errado" }) as never,
      DISPATCHER,
    );

    await expect(
      update().execute(
        { name: "Cliente reagendou" } as never,
        first.id as string,
        CARRIER,
        DISPATCHER,
      ),
    ).resolves.toMatchObject({ name: "Cliente reagendou" });

    await expect(
      update().execute(
        { name: "Cliente reagendou" } as never,
        second.id as string,
        CARRIER,
        DISPATCHER,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STATUS_CHANGE_REASON_NAME_TAKEN",
    });

    await expect(
      update().execute(
        { name: "Endereço não localizado" } as never,
        second.id as string,
        CARRIER,
        DISPATCHER,
      ),
    ).resolves.toMatchObject({ name: "Endereço não localizado" });
  });

  it("answers another company's reason as absent on edit and delete (404), and keeps it", async () => {
    const foreign = await create().execute(
      reasonOf({ businessId: OTHER }) as never,
      OTHER_DISPATCHER,
    );

    await expect(
      update().execute(
        { name: "Tomado" } as never,
        foreign.id as string,
        CARRIER,
        DISPATCHER,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STATUS_CHANGE_REASON_NOT_FOUND",
    });

    await expect(
      remove().execute(foreign.id as string, CARRIER, DISPATCHER),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STATUS_CHANGE_REASON_NOT_FOUND",
    });

    expect(reasons.statusChangeReasons[0]).toMatchObject({
      name: "Cliente reagendou",
    });
  });

  it("refuses deleting a reason the history cites (409) and deletes an unused one", async () => {
    const created = await create().execute(reasonOf() as never, DISPATCHER);
    reasons.eventCountByReasonId.set(created.id as string, 2);

    await expect(
      remove().execute(created.id as string, CARRIER, DISPATCHER),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STATUS_CHANGE_REASON_IN_USE",
    });

    reasons.eventCountByReasonId.delete(created.id as string);
    await remove().execute(created.id as string, CARRIER, DISPATCHER);

    expect(reasons.statusChangeReasons).toHaveLength(0);
  });

  it("refuses a driver on edit and delete (403)", async () => {
    const created = await create().execute(reasonOf() as never, DISPATCHER);

    await expect(
      update().execute(
        { name: "X" } as never,
        created.id as string,
        CARRIER,
        DRIVER_USER,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      remove().execute(created.id as string, CARRIER, DRIVER_USER),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
