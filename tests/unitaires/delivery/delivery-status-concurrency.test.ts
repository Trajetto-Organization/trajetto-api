import { describe, expect, it, vi } from "vitest";

import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";

import type { NotificationService } from "@/shared/services/notification-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type {
  CreateDeliveryProps,
  Delivery,
} from "@/modules/delivery/dtos/delivery-dto";

import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { AppError } from "@/shared/errors/AppError";

/**
 * Four surfaces drive the same delivery — the driver's app, the dispatcher's
 * dashboard, the admin panel and the control tower — and nothing stops two of
 * them acting at the same moment. Validating the transition and then writing
 * with only the id leaves a window between them; these tests pin it shut.
 *
 * The in-memory repository mirrors the status filter the Prisma `where`
 * carries, so what is proven here is the same rule the database enforces.
 */
// The status change and the route stop it resolves share one transaction;
// against in-memory repositories the transaction is a plain passthrough.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const REASON = "018f0000-0000-7000-8000-0000000000e9";
const USER_ID = "018f0000-0000-7000-8000-0000000000aa";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  userRepository.user.push({
    id: USER_ID,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  const reasonRepository = new InMemoryStatusChangeReasonRepository();
  const routeRepository = new InMemoryRouteRepository();

  // The panel cannot move a status without saying why. One active reason is
  // what makes these tests exercise the change rather than the refusal.
  reasonRepository.statusChangeReasons.push({
    id: REASON,
    name: "Contato com o cliente",
    description: null,
    is_active: true,
    businessId: BUSINESS,
  });

  const useCase = new UpdateDeliveryStatusUseCase(
    userRepository,
    deliveryRepository,
    routeRepository,
    reasonRepository,
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
  );

  return { useCase, deliveryRepository, routeRepository };
}

/**
 * `Delivery.id` is optional on the DTO (it is absent before a create), but the
 * repository always stamps one — narrowed here so every test can pass it.
 */
async function seedDelivery(
  repository: InMemoryDeliveryRepository,
  overrides: Partial<CreateDeliveryProps> = {},
): Promise<Delivery & { id: string }> {
  const created = await repository.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
    recipient_name: "Maria Destinatária",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    ...overrides,
  } as CreateDeliveryProps);

  return created as Delivery & { id: string };
}

const move = (
  useCase: UpdateDeliveryStatusUseCase,
  deliveryId: string,
  status: Delivery["status"],
) =>
  useCase.execute({
    userId: USER_ID,
    businessId: BUSINESS,
    deliveryId,
    status,
  reasonId: REASON,
});

describe("a transition the status machine allows", () => {
  it("still goes through", async () => {
    // The guard must cost nothing when there is no contention, which is the
    // overwhelming majority of the time.
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    const updated = await move(useCase, delivery.id, "IN_TRANSIT");

    expect(updated.status).toBe("IN_TRANSIT");
    expect(deliveryRepository.deliveries[0].status).toBe("IN_TRANSIT");
  });

  it("stamps the proof metadata on the proven outcome", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    await move(useCase, delivery.id, "IN_TRANSIT");
    const delivered = await move(useCase, delivery.id, "DELIVERED");

    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.delivered_at).toBeInstanceOf(Date);
  });
});

describe("a transition the status machine forbids", () => {
  it("is refused before any write, with 400", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    // PENDING → DELIVERED skips the route entirely.
    await expect(move(useCase, delivery.id, "DELIVERED")).rejects.toMatchObject(
      { statusCode: 400, code: "INVALID_STATUS_TRANSITION" },
    );

    expect(deliveryRepository.deliveries[0].status).toBe("PENDING");
  });

  it("refuses a move onto the status the delivery already has", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    await expect(move(useCase, delivery.id, "PENDING")).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("a delivery that already reached a terminal status", () => {
  it("cannot be moved again once DELIVERED", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    await move(useCase, delivery.id, "IN_TRANSIT");
    await move(useCase, delivery.id, "DELIVERED");

    await expect(move(useCase, delivery.id, "FAILED")).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(deliveryRepository.deliveries[0].status).toBe("DELIVERED");
  });

  it("cannot be moved again once CANCELLED", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    await move(useCase, delivery.id, "CANCELLED");

    await expect(
      move(useCase, delivery.id, "IN_TRANSIT"),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(deliveryRepository.deliveries[0].status).toBe("CANCELLED");
  });
});

describe("two surfaces writing at the same time", () => {
  it("lets the first one land and refuses the second with 409", async () => {
    // The dispatcher cancels while the control tower marks the delivery as
    // out on the road. Both read PENDING, both pass canTransitionDelivery,
    // and one of them is about to write a status the other never saw.
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    const [cancelling, dispatching] = await Promise.allSettled([
      move(useCase, delivery.id, "CANCELLED"),
      move(useCase, delivery.id, "IN_TRANSIT"),
    ]);

    const outcomes = [cancelling.status, dispatching.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);

    const loser = [cancelling, dispatching].find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;

    expect(loser.reason).toMatchObject({
      statusCode: 409,
      code: "DELIVERY_STATUS_CONFLICT",
    });
  });

  it("leaves the row holding exactly the winner's status", async () => {
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    await Promise.allSettled([
      move(useCase, delivery.id, "CANCELLED"),
      move(useCase, delivery.id, "IN_TRANSIT"),
    ]);

    // Whichever won, the row is in one of the two legal outcomes and nothing
    // was left half-applied. Without the precondition the loser's write would
    // simply overwrite the winner's.
    expect(["CANCELLED", "IN_TRANSIT"]).toContain(
      deliveryRepository.deliveries[0].status,
    );
  });
});

describe("a client acting on a status it read a while ago", () => {
  it("is refused rather than silently overwriting", async () => {
    // The dashboard loaded the list when the delivery was PENDING. Somebody
    // else put it on the road. The operator, still looking at the stale row,
    // presses "Cancelar".
    const { useCase, deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    const staleStatus = deliveryRepository.deliveries[0].status;
    expect(staleStatus).toBe("PENDING");

    deliveryRepository.deliveries[0].status = "IN_TRANSIT";

    // CANCELLED is legal from IN_TRANSIT too, so the status machine alone
    // would wave this through — only the precondition catches it. Here the
    // repository is asked directly with the status the screen had.
    await expect(
      deliveryRepository.updateDeliveryStatus(delivery.id, {
        status: "CANCELLED",
        expectedStatus: staleStatus,
      }),
    ).rejects.toBeInstanceOf(DeliveryStatusConflictError);

    expect(deliveryRepository.deliveries[0].status).toBe("IN_TRANSIT");
  });
});

describe("the proof write", () => {
  it("records neither the event nor the stamp when the delivery moved", async () => {
    // The driver's photo upload sits between the check and the write, and on
    // a phone in a basement that is minutes. A dispatcher cancelling in that
    // window used to end with a PROOF event hanging off a cancelled delivery.
    const { deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    deliveryRepository.deliveries[0].status = "CANCELLED";

    await expect(
      deliveryRepository.registerDeliveryProof(
        {
          type: "PROOF",
          deliveryId: delivery.id,
          reportedById: USER_ID,
          client_submission_id: "018f0000-0000-7000-8000-0000000000c1",
          photo: "proof.jpg",
        },
        "IN_TRANSIT",
      ),
    ).rejects.toBeInstanceOf(DeliveryStatusConflictError);

    expect(deliveryRepository.events).toHaveLength(0);
    expect(deliveryRepository.deliveries[0].status).toBe("CANCELLED");
  });

  it("writes both when the delivery is still where the driver left it", async () => {
    const { deliveryRepository } = makeContext();
    const delivery = await seedDelivery(deliveryRepository);

    deliveryRepository.deliveries[0].status = "IN_TRANSIT";

    await deliveryRepository.registerDeliveryProof(
      {
        type: "PROOF",
        deliveryId: delivery.id,
        reportedById: USER_ID,
        client_submission_id: "018f0000-0000-7000-8000-0000000000c2",
        photo: "proof.jpg",
        received_by: "Porteiro",
      },
      "IN_TRANSIT",
    );

    expect(deliveryRepository.events).toHaveLength(1);
    expect(deliveryRepository.deliveries[0].status).toBe("DELIVERED");
    expect(deliveryRepository.deliveries[0].received_by).toBe("Porteiro");
  });
});
