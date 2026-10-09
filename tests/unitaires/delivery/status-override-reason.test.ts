import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps, Delivery } from "@/modules/delivery/dtos/delivery-dto";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

// Nothing here asserts on webhooks; the use cases simply require one.
const webhookStub = new InMemoryWebhookFanOutService();

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

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  const routeRepository = new InMemoryRouteRepository();
  const reasonRepository = new InMemoryStatusChangeReasonRepository();

  userRepository.user.push(
    {
      id: OPERATOR,
      name: "Operadora do SAC",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,

    // The person who is carrying the delivery, and whose phone is the whole
    // point of the notification below.
    {
      id: DRIVER_USER,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

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

  /**
   * Records instead of discarding: the outbox is the only way a use case is
   * allowed to reach a driver's phone, so what it received IS the
   * notification behaviour under test.
   */
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];

  const outboxStub = {
    publish: async (
      _tx: unknown,
      event: { topic: string; payload: Record<string, unknown> },
    ) => {
      published.push({ topic: event.topic, payload: event.payload });
    },
  } as unknown as OutboxService;

  return {
    userRepository,
    deliveryRepository,
    routeRepository,
    reasonRepository,

    published,

    setStatus: new UpdateDeliveryStatusUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      reasonRepository,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
      outboxStub,
      webhookStub.asService(),
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

async function seedDelivery(
  overrides: Partial<CreateDeliveryProps> = {},
): Promise<Delivery & { id: string }> {
  const created = await context.deliveryRepository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Destinatário",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...overrides,
  } as CreateDeliveryProps);

  return created as Delivery & { id: string };
}

/** Everything the outbox was handed for the driver's phone. */
function overrideNotices() {
  return context.published.filter(
    (event) => event.topic === "delivery.status_overridden",
  );
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
    // (With a driver: the panel does not put a driverless load in transit.)
    const delivery = await seedDelivery({ driverId: DRIVER });

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


describe("telling the driver their day changed", () => {
  /**
   * The gap this closes: the panel cancelled a delivery and the driver's app
   * simply lost the row on the next sync. Nobody told them anything, and with
   * a seven-day offline cache the stale row could sit on the phone for hours
   * first. They drove to an address that had been called off.
   */
  it("publishes when a stop is taken off the driver's list", async () => {
    const delivery = await seedDelivery({ driverId: DRIVER });

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
      note: "cliente ligou às 14h",
    });

    const [notice] = overrideNotices();

    expect(notice).toBeDefined();

    expect(notice.payload).toMatchObject({
      deliveryId: delivery.id,
      driverUserId: DRIVER_USER,
      recipientName: "Destinatário",
      fromLabel: "Pendente",
      toLabel: "Cancelada",
      reason: "Cliente cancelou por telefone",
      note: "cliente ligou às 14h",
      removedFromWorklist: true,
    });
  });

  it("refuses the whole change when the driver cannot be told", async () => {
    // The publish is AWAITED inside the transaction, not fired after it. If it
    // were fire-and-forget, an outbox failure would leave the delivery
    // cancelled in the database and the driver never told — which is the exact
    // state this feature exists to prevent. Against Postgres the same throw
    // rolls the status back; here what is proven is that it is on the critical
    // path at all.
    const delivery = await seedDelivery({ driverId: DRIVER });

    const brittle = new UpdateDeliveryStatusUseCase(
      context.userRepository,
      context.deliveryRepository,
      context.routeRepository,
      context.reasonRepository,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
      {
        publish: async () => {
          throw new Error("outbox down");
        },
      } as unknown as OutboxService,
      webhookStub.asService(),
    );

    await expect(
      brittle.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: REASON,
      }),
      // A 500 and not a 4xx: the request was well formed and allowed, the
      // machinery failed. Asserting the status rather than a bare toThrow()
      // matters — a use case that fell over on its way to the publish would
      // satisfy "throws" and prove nothing.
      //
      // The fake cannot show the rollback (its array was already mutated);
      // against Postgres the same throw takes the status back with it, which
      // is the point of publishing inside the transaction.
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("stays quiet when the delivery has no driver", async () => {
    const delivery = await seedDelivery();

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(overrideNotices()).toEqual([]);
  });

  it("stays quiet on a move that keeps the stop on the list", async () => {
    // Marking a load as departed changes nothing the driver can act on, and
    // a bell for every bookkeeping move is how a tray stops being read.
    const delivery = await seedDelivery({ driverId: DRIVER });

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "IN_TRANSIT",
      reasonId: REASON,
    });

    expect(overrideNotices()).toEqual([]);
  });

  it("carries the address, so the driver recognises the stop", async () => {
    const delivery = await seedDelivery({ driverId: DRIVER });

    await context.setStatus.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: delivery.id,
      status: "CANCELLED",
      reasonId: REASON,
    });

    expect(overrideNotices()[0].payload.addressLabel).toBe(
      "Rua das Entregas, São Paulo",
    );
  });

  it("publishes nothing when the override itself was refused", async () => {
    const delivery = await seedDelivery({ driverId: DRIVER });

    await expect(
      context.setStatus.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: delivery.id,
        status: "CANCELLED",
        reasonId: RETIRED_REASON,
      }),
    ).rejects.toMatchObject({ code: "STATUS_CHANGE_REASON_INACTIVE" });

    expect(overrideNotices()).toEqual([]);
  });
});
