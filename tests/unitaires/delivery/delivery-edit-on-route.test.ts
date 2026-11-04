import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";

import {
  deliveryEditChanges,
  deliveryEditNote,
} from "@/shared/delivery/delivery-edit-changes";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type {
  CreateDeliveryProps,
  Delivery,
} from "@/modules/delivery/dtos/delivery-dto";
import type { Route, RouteStop } from "@/modules/route/dtos/route-dto";

/**
 * Editing a delivery the driver already has (K9).
 *
 * The office fixed the address of a delivery on a released route and the
 * driver never knew: the plan did not move a version, so the phone kept the
 * old address, and the trail did not say anything changed. Now the edit
 * commits with the route's lock and a new plan version (the phone refetches
 * and the driver is pushed — announcePlanChange), and the delivery's trail
 * says what changed. An edit that changes nothing moves nothing, and a
 * delivery on no route edits as before.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const announcements = vi.hoisted(() => ({ business: [] as unknown[] }));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: (_businessId: string, event: unknown) => {
    announcements.business.push(event);
  },
  sendRouteEventToDriver: () => undefined,
}));

const BUSINESS = "018f0000-0000-7000-8000-0000000009b1";
const OPERATOR = "018f0000-0000-7000-8000-0000000009a1";
const DRIVER = "018f0000-0000-7000-8000-0000000009d1";
const SHIPPER = "018f0000-0000-7000-8000-0000000009f1";
const ROUTE = "018f0000-0000-7000-8000-0000000009e1";

let deliveries: InMemoryDeliveryRepository;
let routes: InMemoryRouteRepository;
let update: UpdateDeliveryUseCase;

beforeEach(() => {
  announcements.business.length = 0;

  const users = new InMemoryUserRepository();
  const shippers = new InMemoryShipperRepository();

  deliveries = new InMemoryDeliveryRepository();
  routes = new InMemoryRouteRepository(deliveries.deliveries);
  deliveries.routeStops = routes.stops;

  users.user.push({
    id: OPERATOR,
    name: "Despachante",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  shippers.shippers.push({
    id: SHIPPER,
    name: "Ativo",
    businessId: BUSINESS,
    is_active: true,
  } as Shipper);

  update = new UpdateDeliveryUseCase(users, shippers, deliveries, routes);
});

async function seed(): Promise<string> {
  const created = await deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Mercado Central",
    recipient_telephone: "11999990000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    address_number: "10",
    items: [{ description: "Caixa", quantity: 2 }],
  } as CreateDeliveryProps);

  return created.id!;
}

function onRoute(deliveryId: string, status: Route["status"] = "RELEASED") {
  routes.routes.push({
    id: ROUTE,
    code: 7,
    status,
    driverId: DRIVER,
    vehicleId: null,
    businessId: BUSINESS,
    plan_version: 3,
    scheduled_date: new Date("2026-11-03"),
  } as Route);

  routes.stops.push({
    id: "018f0000-0000-7000-8000-0000000009c1",
    routeId: ROUTE,
    deliveryId,
    sequence: 10,
    status: "PENDING",
  } as RouteStop);
}

const edit = (deliveryId: string, body: Record<string, unknown>) =>
  update.execute({
    userId: OPERATOR,
    businessId: BUSINESS,
    deliveryId,
    deliveryData: updateDeliverySchema.parse(body),
  });

const notes = (deliveryId: string) =>
  deliveries.events.filter(
    (event) => event.deliveryId === deliveryId && event.type === "NOTE",
  );

describe("editing a delivery on a released route", () => {
  it("moves the plan a version, tells the screens and says what changed", async () => {
    const deliveryId = await seed();
    onRoute(deliveryId);

    await edit(deliveryId, {
      street: "Rua Dois",
      recipient_telephone: "11988887777",
      recipient_name: "Mercado Central",
      items: [{ description: "Caixa", quantity: 2 }],
    });

    expect(routes.routes[0].plan_version).toBe(4);
    expect(announcements.business).toEqual([
      expect.objectContaining({
        type: "route.stops_changed",
        routeId: ROUTE,
        planVersion: 4,
      }),
    ]);
    expect(notes(deliveryId)).toEqual([
      expect.objectContaining({
        actor: "USER",
        reportedById: OPERATOR,
        routeId: ROUTE,
        note: "Dados alterados no painel: endereço e telefone.",
      }),
    ]);
  });

  it("moves nothing for an edit that changes nothing", async () => {
    const deliveryId = await seed();
    onRoute(deliveryId);

    await edit(deliveryId, {
      street: "RUA UM",
      recipient_name: "Mercado Central",
      items: [{ description: "Caixa", quantity: 2 }],
    });

    expect(routes.routes[0].plan_version).toBe(3);
    expect(announcements.business).toEqual([]);
    expect(notes(deliveryId)).toEqual([]);
  });

  it("does the same on a route still being planned", async () => {
    const deliveryId = await seed();
    onRoute(deliveryId, "PLANNED");

    await edit(deliveryId, { items: [{ description: "Palete", quantity: 1 }] });

    expect(routes.routes[0].plan_version).toBe(4);
    expect(notes(deliveryId)[0].note).toBe("Dados alterados no painel: itens.");
  });
});

describe("editing a delivery on no route", () => {
  it("edits as before: no plan, no line", async () => {
    const deliveryId = await seed();

    const updated = await edit(deliveryId, { street: "Rua Dois" });

    expect(updated.street).toBe("Rua Dois");
    expect(announcements.business).toEqual([]);
    expect(notes(deliveryId)).toEqual([]);
  });
});

describe("the changes an edit names", () => {
  const current = {
    recipient_name: "Mercado",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
    notes: null,
  } as Delivery;

  it("ignores values resent as they were, dates by their day", () => {
    expect(
      deliveryEditChanges(current, [], {
        recipient_name: " Mercado ",
        city: "SÃO PAULO",
        scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
        notes: null,
      }),
    ).toEqual([]);
  });

  it("names each change once, in a stable order", () => {
    const labels = deliveryEditChanges(current, [], {
      notes: "Portão azul",
      uf: "RJ",
      city: "Rio de Janeiro",
      scheduled_date: new Date("2026-11-04T00:00:00.000Z"),
    });

    expect(labels).toEqual(["endereço", "data prevista", "observações"]);
    expect(deliveryEditNote(labels)).toBe(
      "Dados alterados no painel: endereço, data prevista e observações.",
    );
  });
});
