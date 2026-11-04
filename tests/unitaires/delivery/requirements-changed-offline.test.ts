import { describe, expect, it, vi } from "vitest";

import { businessWithoutAI } from "../../support/delivery-proof-usecases";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { AppError } from "@/shared/errors/AppError";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * A requirement switched on while a report waited in the offline queue
 * (K2, decision D29).
 *
 * The driver tapped "Cliente ausente" at 14:00 with no signal; at 14:30 the
 * company started asking for a photo; the phone reached the server at 15:00.
 * The report was checked against the type as it is NOW and refused with 400
 * OCCURRENCE_PHOTO_REQUIRED — a permanent failure in the app, for a report
 * that obeyed every rule there was when it was made. It is accepted now, and
 * flagged on the delivery's trail for review, the way a proof tapped before
 * its type was deactivated is accepted (deactivated_at). A tap after the
 * change is still refused, and so is a report that carries no tap time.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000020b";
const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000002a1";
const OPERATOR_ID = "018f0000-0000-7000-8000-0000000002a2";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000002d1";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000002f1";
const ABSENT_TYPE = "018f0000-0000-7000-8000-0000000002c1";
const DELIVERED_TYPE = "018f0000-0000-7000-8000-0000000002c2";

const CHANGED_AT = new Date("2026-11-03T14:30:00.000Z");
const BEFORE = new Date("2026-11-03T14:00:00.000Z");
const AFTER = new Date("2026-11-03T14:45:00.000Z");

const key = (n: number) =>
  `018f0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeContext() {
  const users = new InMemoryUserRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository();
  const types = new InMemoryOccurrenceTypeRepository();

  deliveries.routeStops = routes.stops;

  users.user.push(
    {
      id: DRIVER_USER_ID,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER_ID,
    } as User,
    {
      id: OPERATOR_ID,
      name: "Olga Torre",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
  );

  types.occurrenceTypes.push(
    {
      id: ABSENT_TYPE,
      name: "Cliente ausente",
      category: "NOT_DELIVERED",
      blocks_delivery: true,
      requires_photo: true,
      is_active: true,
      requirements_changed_at: CHANGED_AT,
      businessId: BUSINESS,
    } as OccurrenceType,
    {
      id: DELIVERED_TYPE,
      name: "Entrega normal",
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_signature: true,
      is_active: true,
      requirements_changed_at: CHANGED_AT,
      businessId: BUSINESS,
    } as OccurrenceType,
  );

  const report = new ReportDeliveryOccurrenceUseCase(
    users,
    types,
    deliveries,
    routes,
    {
      createActivityIfEnabled: async () => {},
    } as unknown as NotificationService,
    {
      resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
        photos.map(({ key: path }) => ({ path })),
    } as unknown as UploadService,
    { publish: async () => {} } as unknown as OutboxService,
    new InMemoryWebhookFanOutService().asService(),
    new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users),
    new InMemoryProofAuditRepository(),
    businessWithoutAI,
  );

  return { deliveries, report };
}

async function seedInTransit(
  deliveries: InMemoryDeliveryRepository,
): Promise<string> {
  const delivery = await deliveries.createDelivery({
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId: BUSINESS,
    shipperId: SHIPPER_ID,
  } as CreateDeliveryProps);

  delivery.driverId = DRIVER_ID;
  delivery.status = "IN_TRANSIT";

  return delivery.id!;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    throw error;
  }

  throw new Error("expected a refusal");
}

function flagsOn(deliveries: InMemoryDeliveryRepository, deliveryId: string) {
  return deliveries.events.filter(
    (event) =>
      event.deliveryId === deliveryId &&
      event.type === "NOTE" &&
      event.actor === "SYSTEM",
  );
}

describe("a problem report tapped before the company asked for a photo", () => {
  it("is accepted with its effect, and flagged on the trail for review", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    const result = await context.report.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: ABSENT_TYPE,
      client_submission_id: key(1),
      occurredAt: BEFORE,
    });

    expect(result.delivery_status).toBe("FAILED");

    const [flag, ...more] = flagsOn(context.deliveries, deliveryId);

    expect(more).toHaveLength(0);
    expect(flag).toMatchObject({
      occurrenceId: result.id,
      occurred_at: BEFORE,
      note: 'Aceita sem a foto anexada: o motorista registrou no aplicativo antes de o tipo "Cliente ausente" passar a exigir. Confira o registro.',
    });
  });

  it("is refused when the tap came after the change", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    expect(
      await refusal(
        context.report.execute({
          userId: DRIVER_USER_ID,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: ABSENT_TYPE,
          client_submission_id: key(2),
          occurredAt: AFTER,
        }),
      ),
    ).toBe("400 OCCURRENCE_PHOTO_REQUIRED");
  });

  it("is refused when it carries no tap time (sent online)", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    expect(
      await refusal(
        context.report.execute({
          userId: DRIVER_USER_ID,
          businessId: BUSINESS,
          deliveryId,
          occurrenceTypeId: ABSENT_TYPE,
          client_submission_id: key(3),
        }),
      ),
    ).toBe("400 OCCURRENCE_PHOTO_REQUIRED");
  });

  it("writes no flag when nothing was missing", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    await context.report.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: ABSENT_TYPE,
      client_submission_id: key(4),
      photos: ["deliveryPhotos/portao.jpg"],
      occurredAt: BEFORE,
    });

    expect(flagsOn(context.deliveries, deliveryId)).toHaveLength(0);
  });
});

describe("a proof tapped before the type asked for a signature", () => {
  it("is delivered, and the flag names every requirement it went without", async () => {
    const context = makeContext();
    const deliveryId = await seedInTransit(context.deliveries);

    const result = await context.report.execute({
      userId: DRIVER_USER_ID,
      businessId: BUSINESS,
      deliveryId,
      occurrenceTypeId: DELIVERED_TYPE,
      client_submission_id: key(5),
      occurredAt: BEFORE,
    });

    expect(result.delivery_status).toBe("DELIVERED");
    expect(flagsOn(context.deliveries, deliveryId)[0].note).toBe(
      'Aceita sem a foto do canhoto e a assinatura de quem recebeu: o motorista registrou no aplicativo antes de o tipo "Entrega normal" passar a exigir. Confira o registro.',
    );
  });
});
