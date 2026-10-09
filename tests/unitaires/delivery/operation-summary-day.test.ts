import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationSummaryUseCase } from "@/modules/delivery/usecases/operation-summary/operation-summary-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { CreateDeliveryProps, Delivery } from "@/modules/delivery/dtos/delivery-dto";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * "Operação de hoje" in the company's own day (DLVP-OPS-1/2/3, DLV-MON-3).
 *
 * The clock is pinned at 21:30 in Manaus (UTC-4), 01:30 UTC of the next day
 * and 22:30 in São Paulo. The old code cut the day at the server's midnight:
 * in a UTC container that is 00:00Z (everything of the Manaus afternoon was
 * "yesterday"), on a machine in São Paulo it is 03:00Z (the Manaus evening
 * before was "today"). Both disagree with Manaus, which is the point.
 *
 * The day's documents are the tower's (decision 7.1), so they are seeded in
 * the tower's twin; the delivery twin holds the same deliveries for the two
 * numbers only it answers — the backlog and the driver's reports. `seed`
 * writes both, as one table would.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000000b1";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-0000000000b2";

const MANAGER_ID = "018f0000-0000-7000-8000-0000000000a2";
const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const OTHER_MANAGER_ID = "018f0000-0000-7000-8000-0000000000a3";
const MASTER_ID = "018f0000-0000-7000-8000-0000000000a9";

const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const FOREIGN_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

const TYPE_BLOCKING = "018f0000-0000-7000-8000-0000000000e1";
const TYPE_INFO = "018f0000-0000-7000-8000-0000000000e2";
const TYPE_SYSTEM = "018f0000-0000-7000-8000-0000000000e3";

// 21:30 on 27/09 in Manaus; its day is [27T04:00Z, 28T04:00Z).
const NOW = new Date("2026-09-28T01:30:00.000Z");

const TODAY_AFTERNOON = new Date("2026-09-27T20:00:00.000Z"); // 16:00 Manaus
const YESTERDAY_LATE = new Date("2026-09-27T03:30:00.000Z"); // 23:30 of 26/09 in Manaus, 00:30 of 27/09 in SP
const LONG_AGO = new Date("2026-08-01T12:00:00.000Z");

function makeRepositories() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const operation = new InMemoryOperationDayRepository();

  operation.rows.businesses.push({ id: BUSINESS, timezone: "America/Manaus" });

  operation.rows.drivers.push(
    { id: DRIVER_ID, businessId: BUSINESS, name: "João Motorista", cnh: "111" },
    { id: FOREIGN_DRIVER_ID, businessId: OTHER_BUSINESS, name: "De Outra Empresa", cnh: "999" },
  );

  operation.rows.occurrenceTypes.push(
    { id: TYPE_BLOCKING, name: "Recusa", blocks_delivery: true },
    { id: TYPE_INFO, name: "Atraso", blocks_delivery: false },
    { id: TYPE_SYSTEM, name: "Comprovante rejeitado", blocks_delivery: false },
  );

  users.user.push(
    { id: MANAGER_ID, name: "Gestora", role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER_ID,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
    {
      id: OTHER_MANAGER_ID,
      name: "Gestor de outra empresa",
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    } as User,
    { id: MASTER_ID, name: "Master", role: "MASTER", businessId: null } as User,
  );

  deliveries.occurrenceTypeSystem.set(TYPE_SYSTEM, true);
  deliveries.driverUserIds.add(DRIVER_USER_ID);

  return { users, deliveries, operation };
}

type Repositories = ReturnType<typeof makeRepositories>;

/** One delivery row, in both twins (the delivery table seen by each). */
async function seed(
  repos: Repositories,
  overrides: Partial<Delivery> = {},
): Promise<Delivery> {
  const delivery = await repos.deliveries.createDelivery({
    recipient_name: "Cliente",
    city: "Manaus",
    uf: "AM",
    street: "Rua",
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
  } as CreateDeliveryProps);

  Object.assign(delivery, { driverId: DRIVER_ID, updated_at: NOW }, overrides);

  repos.operation.rows.deliveries.push({
    id: delivery.id!,
    businessId: delivery.businessId,
    status: delivery.status as never,
    driverId: delivery.driverId ?? null,
    recipient_name: delivery.recipient_name,
    city: delivery.city,
    delivered_at: delivery.delivered_at ? new Date(delivery.delivered_at) : null,
    updated_at: new Date(delivery.updated_at!),
  });

  return delivery;
}

/** A PENDING delivery on a stop of a route of `scheduled` in `status`. */
async function onRoute(repos: Repositories, scheduled: string, status: string) {
  const delivery = await seed(repos, { status: "PENDING" });
  const routeId = `route-${repos.operation.rows.routes.length + 1}`;

  repos.operation.rows.routes.push({
    id: routeId,
    businessId: BUSINESS,
    code: repos.operation.rows.routes.length + 1,
    name: null,
    destination: null,
    status: status as never,
    scheduled_date: new Date(`${scheduled}T00:00:00.000Z`),
    planned_departure_at: null,
    started_at: null,
    completed_at: null,
    updated_at: LONG_AGO,
    driverId: DRIVER_ID,
    vehicleId: null,
  });

  repos.operation.rows.stops.push({
    id: `${routeId}-stop`,
    routeId,
    deliveryId: delivery.id!,
    sequence: 10,
    status: "PENDING",
    on_the_way_at: null,
    arrived_at: null,
    completed_at: null,
    updated_at: LONG_AGO,
  });
}

function useCase(repos: Repositories) {
  return new OperationSummaryUseCase(repos.users, repos.deliveries, repos.operation);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the day of the operation summary", () => {
  it("delivered: counts the company's afternoon and not its previous night", async () => {
    const repos = makeRepositories();

    await seed(repos, { status: "DELIVERED", delivered_at: TODAY_AFTERNOON });
    await seed(repos, { status: "DELIVERED", delivered_at: YESTERDAY_LATE });

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.totals.deliveredToday).toBe(1);
    expect(summary.drivers[0].deliveredToday).toBe(1);
  });

  it("failed: an old failure edited today is not an insucesso of today", async () => {
    const repos = makeRepositories();

    // Failed yesterday by the panel, edited today (updated_at = now).
    const editedOld = await seed(repos, { status: "FAILED" });
    repos.operation.rows.events.push({
      id: "event-1",
      businessId: BUSINESS,
      deliveryId: editedOld.id!,
      routeId: null,
      occurrenceId: null,
      type: "STATUS_CHANGE",
      actor: "USER",
      status_to: "FAILED",
      occurred_at: YESTERDAY_LATE,
      created_at: YESTERDAY_LATE,
    });

    // Failed this afternoon by a blocking occurrence from the app.
    const failedToday = await seed(repos, { status: "FAILED" });
    repos.operation.rows.occurrences.push({
      id: "occurrence-1",
      businessId: BUSINESS,
      deliveryId: failedToday.id!,
      occurrenceTypeId: TYPE_BLOCKING,
      authorization_status: "NOT_REQUIRED",
      occurred_at: TODAY_AFTERNOON,
      created_at: TODAY_AFTERNOON,
    });

    // A legacy failure with no fact at all falls back to updated_at.
    await seed(repos, { status: "FAILED" });

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.totals.failedToday).toBe(2);
    expect(summary.drivers[0].failedToday).toBe(2);
  });

  it("occurrences: only the driver's reports, by when they happened, without system types", async () => {
    const repos = makeRepositories();
    const delivery = await seed(repos, { status: "IN_TRANSIT" });

    const report = (
      reportedById: string,
      occurrenceTypeId: string,
      occurred_at: Date | null,
    ) =>
      repos.deliveries.createOccurrence({
        deliveryId: delivery.id!,
        occurrenceTypeId,
        reportedById,
        occurred_at,
      });

    await report(DRIVER_USER_ID, TYPE_INFO, TODAY_AFTERNOON); // counts
    await report(DRIVER_USER_ID, TYPE_INFO, null); // counts: happened on arrival, now
    await report(MANAGER_ID, TYPE_INFO, null); // a panel note, not a driver report
    await report(DRIVER_USER_ID, TYPE_SYSTEM, null); // "Comprovante rejeitado"
    await report(DRIVER_USER_ID, TYPE_INFO, YESTERDAY_LATE); // offline, from yesterday

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.totals.occurrencesToday).toBe(2);
  });

  it("designated: the tower's load of the day, not tomorrow's routes nor routeless work", async () => {
    const repos = makeRepositories();

    // At 21:30 in Manaus it is still the 27th there and already the 28th in
    // UTC: the route of the 28th is tomorrow's, whatever the server thinks.
    await onRoute(repos, "2026-09-27", "RELEASED"); // today's route: counts
    await onRoute(repos, "2026-09-26", "IN_PROGRESS"); // left yesterday, still out: counts
    await onRoute(repos, "2026-09-28", "PLANNED"); // tomorrow's: not today's load
    await onRoute(repos, "2026-09-26", "RELEASED"); // yesterday's, never left: not today's

    // A driver and no route: on no route of the day, so not the day's load
    // (decision 7.1) — the summary once counted it and disagreed with the
    // tower's funnel.
    await seed(repos, { status: "PENDING" });

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.totals.designated).toBe(2);
    expect(summary.drivers[0].designated).toBe(2);
    expect(summary.totals.unassigned).toBe(0);
  });

  it("sem rota: every PENDING without a driver, of any date", async () => {
    const repos = makeRepositories();

    await seed(repos, { status: "PENDING", driverId: null, created_at: LONG_AGO });
    await seed(repos, { status: "PENDING", driverId: null });
    await seed(repos, { status: "PENDING", driverId: null, businessId: OTHER_BUSINESS });

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.totals.unassigned).toBe(2);
    expect(summary.totals.designated).toBe(0);
  });

  it("never prints another company's driver on the board", async () => {
    const repos = makeRepositories();

    // A delivery pointing at a driver of another tenant (the column has no
    // tenant constraint): the row stays, the name and the CNH do not.
    await seed(repos, { status: "IN_TRANSIT", driverId: FOREIGN_DRIVER_ID });

    const summary = await useCase(repos).execute({ userId: MANAGER_ID });

    expect(summary.drivers).toEqual([
      expect.objectContaining({ driverId: FOREIGN_DRIVER_ID, driverName: "", cnh: "" }),
    ]);
  });
});

describe("who may read it", () => {
  it("refuses a manager of another company", async () => {
    const repos = makeRepositories();

    await expect(
      useCase(repos).execute({ userId: OTHER_MANAGER_ID, businessId: BUSINESS }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("refuses a driver token", async () => {
    const repos = makeRepositories();

    await expect(useCase(repos).execute({ userId: DRIVER_USER_ID })).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_VIEW_PANELS",
    });
  });

  it("lets a MASTER read the company they picked, in that company's day", async () => {
    const repos = makeRepositories();

    await seed(repos, { status: "DELIVERED", delivered_at: TODAY_AFTERNOON });
    await seed(repos, { status: "DELIVERED", delivered_at: YESTERDAY_LATE });
    await seed(repos, {
      businessId: OTHER_BUSINESS,
      status: "DELIVERED",
      delivered_at: TODAY_AFTERNOON,
    });

    const summary = await useCase(repos).execute({ userId: MASTER_ID, businessId: BUSINESS });

    expect(summary.totals.deliveredToday).toBe(1);
  });
});
