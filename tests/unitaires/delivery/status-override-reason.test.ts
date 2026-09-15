import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import type { NotificationService } from "@/shared/services/notification-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps, Delivery } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Moving a delivery by hand, and having to say why.
 *
 * This is the only path in the product that changes a delivery's status
 * without something having happened in the field. Everything the driver's app
 * does carries its own evidence — a photo, a geolocation, a typed occurrence.
 * An override carries none, so the reason IS the evidence, and three days
 * later it is the only thing support has to answer "por que essa está assim?".
 *
 * Before this, the status was a column that changed and nothing recorded who
 * changed it or why.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const OPERATOR = "018f0000-0000-7000-8000-0000000000a1";

const REASON = "018f0000-0000-7000-8000-0000000000e1";
const RETIRED_REASON = "018f0000-0000-7000-8000-0000000000e2";
const FOREIGN_REASON = "018f0000-0000-7000-8000-0000000000e3";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  const routeRepository = new InMemoryRouteRepository();
  const reasonRepository = new InMemoryStatusChangeReasonRepository();

  userRepository.user.push({
    id: OPERATOR,
    name: "Operadora do SAC",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  reasonRepository.statusChangeReasons.push(
    {
      id: REASON,
      name: "Cliente cancelou por telefone",
      description: null,
      is_active: true,
      businessId: BUSINESS,
    },
    {
      id: RETIRED_REASON,
      name: "Motivo antigo",
      description: null,
      is_active: false,
      businessId: BUSINESS,
    },
    {
      id: FOREIGN_REASON,
      name: "Motivo da outra empresa",
      description: null,
      is_active: true,
      businessId: OTHER_BUSINESS,
    },
  );

  return {
    deliveryRepository,
    reasonRepository,

    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      reasonRepository,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(): Promise<Delivery & { id: string }> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatário",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
  } as CreateDeliveryProps);

  return created as Delivery & { id: string };
}

/**
 * Read the row back rather than holding the object the seed returned.
 *
 * The in-memory repository REPLACES the array entry on a status write, which
 * is the faithful shape: a Prisma read hands back a detached snapshot, and a
 * fake whose returned object kept updating itself would let a test believe
 * something the real repository never does.
 */
function storedDelivery(id: string) {
  return context.deliveryRepository.deliveries.find(
    (entry) => entry.id === id,
  )!;
}

describe("the reason the override has to carry", () => {
  it("refuses a reason that does not exist", async () => {
    const delivery = await seedDelivery();

    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: "018f0000-0000-7000-8000-00000000dead",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STATUS_CHANGE_REASON_NOT_FOUND",
    });

    expect(storedDelivery(delivery.id).status).toBe("PENDING");
  });

  it("refuses another company's reason with the same 404", async () => {
    // Not 403: a different refusal for "exists but is not yours" would tell a
    // caller which ids are real, one request at a time.
    const delivery = await seedDelivery();

    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: FOREIGN_REASON,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STATUS_CHANGE_REASON_NOT_FOUND",
    });

    expect(storedDelivery(delivery.id).status).toBe("PENDING");
  });

  it("refuses a reason the company retired", async () => {
    // A retired reason keeps explaining the events that already cite it and
    // stops being offered for new ones. That is what deactivating is for, and
    // why deleting a used reason is refused outright.
    const delivery = await seedDelivery();

    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: RETIRED_REASON,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "STATUS_CHANGE_REASON_INACTIVE",
    });
  });

  it("writes nothing to the trail when it refuses", async () => {
    const delivery = await seedDelivery();

    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: FOREIGN_REASON,
      }),
    ).rejects.toThrow();

    expect(context.deliveryRepository.events).toEqual([]);
  });
});

describe("what the override leaves behind", () => {
  it("records the move, both ends of it, and why", async () => {
    const delivery = await seedDelivery();

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
      note: "Cliente ligou às 14h pedindo para cancelar.",
    });

    expect(storedDelivery(delivery.id).status).toBe("CANCELLED");
    expect(context.deliveryRepository.events).toHaveLength(1);

    const [event] = context.deliveryRepository.events;

    expect(event).toMatchObject({
      type: "STATUS_CHANGE",
      deliveryId: delivery.id,
      reportedById: OPERATOR,
      actor: "USER",

      // Both ends stored, not derived from a previous event: a delivery's
      // status also moves through paths that write no event at all, so
      // reconstructing "from" by looking backwards would be guessing.
      status_from: "PENDING",
      status_to: "CANCELLED",

      reasonId: REASON,
      note: "Cliente ligou às 14h pedindo para cancelar.",
    });
  });

  it("carries no note when the operator typed none", async () => {
    const delivery = await seedDelivery();

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(context.deliveryRepository.events[0].note).toBeNull();
  });

  it("treats a note of only spaces as no note", async () => {
    const delivery = await seedDelivery();

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
      note: "   ",
    });

    expect(context.deliveryRepository.events[0].note).toBeNull();
  });

  it("records two events for two overrides, and does not collapse them", async () => {
    // Only the driver's app resends. Two clicks on the web are two deliberate
    // decisions, and a trail that merged them would hide that somebody did it
    // twice — which is exactly the kind of thing support is asked about.
    const delivery = await seedDelivery();

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "IN_TRANSIT",
      reasonId: REASON,
    });

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(context.deliveryRepository.events).toHaveLength(2);

    expect(
      context.deliveryRepository.events.map((event) => [
        event.status_from,
        event.status_to,
      ]),
    ).toEqual([
      ["PENDING", "IN_TRANSIT"],
      ["IN_TRANSIT", "CANCELLED"],
    ]);
  });

  it("does not record a move the status machine refused", async () => {
    const delivery = await seedDelivery();

    // PENDING has no path to DELIVERED without passing through the street.
    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "DELIVERED",
        reasonId: REASON,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });

    expect(context.deliveryRepository.events).toEqual([]);
  });
});
