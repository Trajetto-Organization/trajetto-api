import { describe, expect, it, vi } from "vitest";

import { businessWithoutAI } from "../../support/delivery-proof-usecases";

import { RegisterDeliveryArrivalUseCase } from "@/modules/delivery/usecases/register-delivery-arrival/register-delivery-arrival-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * One submission key, one fact (item K13).
 *
 * `client_submission_id` is unique on the WHOLE delivery_event and
 * delivery_occurrence tables, while the replay lookups are scoped to the
 * company. Two holes followed:
 *
 *  - a key another company already used passed the scoped replay check, met
 *    the global unique index at the insert and came back as a 500 — which
 *    the app retries forever;
 *  - the same key sent for ANOTHER delivery (a client bug) was answered as a
 *    replay of the first one: a 200/201 for a fact that was never recorded.
 *
 * Both now answer 409 SUBMISSION_ID_REUSED, the code "a caminho" already
 * gives: the outbox files it for review instead of retrying a key that can
 * never pass.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";
const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";
const OCCURRENCE_TYPE = "018f0000-0000-7000-8000-0000000000c9";
const DELIVERED_TYPE = "018f0000-0000-7000-8000-0000000000ca";
const SUBMISSION = "018f0000-0000-7000-8000-00000000e071";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const outboxStub = { publish: async () => {} } as unknown as OutboxService;

function makeContext() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository();
  const types = new InMemoryOccurrenceTypeRepository();

  deliveries.routeStops = routes.stops;

  users.user.push({
    id: DRIVER_USER_ID,
    name: "João Motorista",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER_ID,
  } as User);

  types.occurrenceTypes.push(
    {
      id: OCCURRENCE_TYPE,
      name: "Cliente ausente",
      category: "NOT_DELIVERED",
      blocks_delivery: false,
      requires_photo: false,
      is_active: true,
      businessId: BUSINESS,
    } as OccurrenceType,
    {
      id: DELIVERED_TYPE,
      name: "Entrega normal",
      category: "DELIVERED",
      requires_receipt_photo: false,
      is_active: true,
      businessId: BUSINESS,
    } as OccurrenceType,
  );

  const webhooks = new InMemoryWebhookFanOutService().asService();

  return {
    deliveries,
    arrival: new RegisterDeliveryArrivalUseCase(
      users,
      deliveries,
      routes,
      notificationStub,
      webhooks,
    ),
    occurrence: new ReportDeliveryOccurrenceUseCase(
      users,
      types,
      deliveries,
      routes,
      notificationStub,
      uploadStub,
      outboxStub,
      webhooks,
      new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users),
      new InMemoryProofAuditRepository(),
      businessWithoutAI,
    ),
  };
}

async function seedInTransit(
  repository: InMemoryDeliveryRepository,
  businessId = BUSINESS,
): Promise<string> {
  const delivery = await repository.createDelivery({
    recipient_name: "Cliente A",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId,
    shipperId: SHIPPER_ID,
  } as CreateDeliveryProps);

  delivery.driverId = businessId === BUSINESS ? DRIVER_ID : null;
  delivery.status = "IN_TRANSIT";

  return delivery.id!;
}

const arrive = (context: ReturnType<typeof makeContext>, deliveryId: string) =>
  context.arrival.execute({
    userId: DRIVER_USER_ID,
    businessId: BUSINESS,
    deliveryId,
    client_submission_id: SUBMISSION,
    latitude: -23.55,
    longitude: -46.63,
  });

const reportAbsent = (
  context: ReturnType<typeof makeContext>,
  deliveryId: string,
) =>
  context.occurrence.execute({
    userId: DRIVER_USER_ID,
    businessId: BUSINESS,
    deliveryId,
    occurrenceTypeId: OCCURRENCE_TYPE,
    client_submission_id: SUBMISSION,
  });

const reused = { statusCode: 409, code: "SUBMISSION_ID_REUSED" };

describe("an arrival key", () => {
  it("replays silently on the delivery it was recorded for", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    await arrive(context, deliveryId);
    await expect(arrive(context, deliveryId)).resolves.toBeUndefined();

    expect(
      context.deliveries.events.filter((e) => e.type === "ARRIVAL"),
    ).toHaveLength(1);
  });

  it("is refused on another delivery instead of answered as its replay", async () => {
    const context = makeContext();
    const first = await seedInTransit(context.deliveries);
    const second = await seedInTransit(context.deliveries);

    await arrive(context, first);

    await expect(arrive(context, second)).rejects.toMatchObject(reused);

    // The second delivery has no arrival: nothing pretended it had one.
    expect(
      context.deliveries.events.filter((e) => e.deliveryId === second),
    ).toHaveLength(0);
  });

  it("is refused when the key already names another kind of event", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    await context.deliveries.createDeliveryEvent({
      type: "ON_THE_WAY",
      deliveryId,
      client_submission_id: SUBMISSION,
    });

    await expect(arrive(context, deliveryId)).rejects.toMatchObject(reused);
  });

  it("answers 409, not 500, when another company holds the key", async () => {
    const context = makeContext();
    const foreign = await seedInTransit(context.deliveries, OTHER_BUSINESS);
    const deliveryId = await seedInTransit(context.deliveries);

    // Invisible to this company's replay lookup; still taken in the index.
    await context.deliveries.createDeliveryEvent({
      type: "ARRIVAL",
      deliveryId: foreign,
      client_submission_id: SUBMISSION,
    });

    await expect(arrive(context, deliveryId)).rejects.toMatchObject(reused);
  });
});

describe("an occurrence key", () => {
  it("replays on the delivery it was recorded for", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    const first = await reportAbsent(context, deliveryId);

    await expect(reportAbsent(context, deliveryId)).resolves.toMatchObject({
      id: first.id,
      replayed: true,
    });
  });

  it("is refused on another delivery instead of answered with the first one", async () => {
    const context = makeContext();
    const first = await seedInTransit(context.deliveries);
    const second = await seedInTransit(context.deliveries);

    await reportAbsent(context, first);

    await expect(reportAbsent(context, second)).rejects.toMatchObject(reused);
    expect(
      context.deliveries.occurrences.filter((o) => o.deliveryId === second),
    ).toHaveLength(0);
  });

  it("answers 409, not 500, when another company holds the key", async () => {
    const context = makeContext();
    const foreign = await seedInTransit(context.deliveries, OTHER_BUSINESS);
    const deliveryId = await seedInTransit(context.deliveries);

    context.deliveries.occurrences.push({
      id: "018f0000-0000-7000-8000-0000000000e8",
      deliveryId: foreign,
      occurrenceTypeId: OCCURRENCE_TYPE,
      reportedById: DRIVER_USER_ID,
      client_submission_id: SUBMISSION,
      created_at: new Date(),
    });

    await expect(reportAbsent(context, deliveryId)).rejects.toMatchObject(
      reused,
    );
  });

  it("refuses a proof whose key already names an arrival", async () => {
    // The PROOF event carries the occurrence's key: a key spent on an
    // arrival met the event index after the occurrence was written — a 500.
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    await arrive(context, deliveryId);

    await expect(
      context.occurrence.execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: DELIVERED_TYPE,
        client_submission_id: SUBMISSION,
      }),
    ).rejects.toMatchObject(reused);

    expect(context.deliveries.occurrences).toHaveLength(0);
  });
});
