import { describe, expect, it, vi } from "vitest";
import {
  legacyProofUseCase,
  businessWithoutAI as reportsWithoutAI,
} from "../../support/delivery-proof-usecases";

import { Prisma } from "@prisma/client";

import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { OccurrenceType } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * A driver's submission whose twin committed while it was still in flight
 * (IDEMP-07).
 *
 * The app gives up after 20 s while the server may still be writing, and the
 * outbox resends at once. concurrent-resend.test.ts covers the resend that
 * loses the status guard at the WRITE. These cover the two windows it leaves:
 *
 *  - the proof's twin commits after the pre-check but before the delivery is
 *    read, so the resend reads DELIVERED and asked "DELIVERED → DELIVERED?"
 *    answered 400 INVALID_STATUS_TRANSITION — a 4xx the app files as a
 *    permanent failure, with "nada foi gravado", for a proof that exists;
 *  - the occurrence's twin commits first, so the resend's insert meets the
 *    unique index on client_submission_id and came back as a 500 — healed by
 *    the next retry, but logged as an error and paid for with a backoff.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DRIVER_USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const SHIPPER_ID = "018f0000-0000-7000-8000-0000000000f1";
const OCCURRENCE_TYPE = "018f0000-0000-7000-8000-0000000000c9";
const SUBMISSION = "018f0000-0000-7000-8000-00000000e071";

const notificationStub = {
  createActivityIfEnabled: async () => {},
} as unknown as NotificationService;

const uploadStub = {
  resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
    photos.map(({ key }) => ({ path: key })),
} as unknown as UploadService;

const outboxStub = { publish: async () => {} } as unknown as OutboxService;

const businessWithoutAI = {
  findBusinessById: async () => ({ ai_analysis_limit: 0 }),
} as unknown as IBusinessRepository;

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository();
  const occurrenceTypeRepository = new InMemoryOccurrenceTypeRepository();

  deliveryRepository.routeStops = routeRepository.stops;

  userRepository.user.push({
    id: DRIVER_USER_ID,
    name: "João Motorista",
    role: "BUSINESS_USER",
    businessId: BUSINESS,
    driverId: DRIVER_ID,
  } as User);

  occurrenceTypeRepository.occurrenceTypes.push({
    id: OCCURRENCE_TYPE,
    name: "Cliente ausente",
    blocks_delivery: true,
    requires_photo: false,
    is_active: true,
    businessId: BUSINESS,
  } as OccurrenceType);

  const webhooks = new InMemoryWebhookFanOutService();

  return {
    deliveryRepository,
    webhooks,
    proof: legacyProofUseCase(
      userRepository,
      deliveryRepository,
      routeRepository,
      notificationStub,
      outboxStub,
      new InMemoryProofAuditRepository(),
      businessWithoutAI,
      uploadStub,
      webhooks.asService(),
    ),
    occurrence: new ReportDeliveryOccurrenceUseCase(
      userRepository,
      occurrenceTypeRepository,
      deliveryRepository,
      routeRepository,
      notificationStub,
      uploadStub,
      outboxStub,
      webhooks.asService(),
      new InMemoryOccurrenceAuthorizationRepository(
        deliveryRepository,
        occurrenceTypeRepository,
        userRepository,
      ),
      new InMemoryProofAuditRepository(),
      reportsWithoutAI,
    ),
  };
}

async function seedInTransit(repository: InMemoryDeliveryRepository) {
  const delivery = await repository.createDelivery({
    recipient_name: "Cliente A",
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

describe("a proof whose twin committed between the pre-check and the read", () => {
  it("answers the resend as the success it is", async () => {
    const context = makeContext();
    const repository = context.deliveryRepository;
    const deliveryId = await seedInTransit(repository);

    const send = () =>
      context.proof.execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId,
        client_submission_id: SUBMISSION,
        photo: "canhoto.jpg",
      });

    // The resend's pre-check runs first and finds nothing; before it reads
    // the delivery, the first attempt finishes and commits.
    const lookup = repository.findEventBySubmissionId.bind(repository);
    let calls = 0;

    repository.findEventBySubmissionId = async (...args) => {
      calls += 1;

      if (calls === 1) {
        await send();
        return null;
      }

      return lookup(...args);
    };

    // Decision 14.3: the proof answers where the submission stands.
    await expect(send()).resolves.toMatchObject({
      replayed: true,
      category: "DELIVERED",
    });

    expect(
      repository.events.filter(
        (event) => event.client_submission_id === SUBMISSION,
      ),
    ).toHaveLength(1);
    expect(context.webhooks.forTopic("proof.registered")).toHaveLength(1);
  });

  it("still refuses a proof for a delivery that is finished and was never proven by it", async () => {
    // The other half: a DELIVERED delivery with no event for this submission
    // is a real refusal, not a resend.
    const context = makeContext();
    const repository = context.deliveryRepository;
    const deliveryId = await seedInTransit(repository);

    repository.deliveries.find((row) => row.id === deliveryId)!.status =
      "DELIVERED";

    await expect(
      context.proof.execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId,
        client_submission_id: SUBMISSION,
        photo: "canhoto.jpg",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_STATUS_TRANSITION",
    });
  });
});

describe("an occurrence whose twin won the unique index", () => {
  it("answers the resend as success instead of a 500", async () => {
    const context = makeContext();
    const repository = context.deliveryRepository;
    const deliveryId = await seedInTransit(repository);

    // The pre-check ran before the twin committed; the insert then meets
    // the twin's row in the unique index.
    const lookup = repository.findOccurrenceBySubmissionId.bind(repository);
    let lookups = 0;

    repository.findOccurrenceBySubmissionId = async (...args) => {
      lookups += 1;
      return lookups === 1 ? null : lookup(...args);
    };

    repository.createOccurrence = async (data) => {
      repository.occurrences.push({
        ...data,
        id: "018f0000-0000-7000-8000-0000000000e9",
        created_at: new Date(),
      });

      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`client_submission_id`)",
        {
          code: "P2002",
          clientVersion: "6.1.0",
          meta: { target: ["client_submission_id"] },
        },
      );
    };

    await expect(
      context.occurrence.execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: OCCURRENCE_TYPE,
        client_submission_id: SUBMISSION,
      }),
      // The resend answers with the twin's occurrence (decision 6.3 made the
      // report return where it stands).
    ).resolves.toMatchObject({
      id: "018f0000-0000-7000-8000-0000000000e9",
      authorization_status: "NOT_REQUIRED",
      replayed: true,
      category: "NOT_DELIVERED",
    });
  });

  it("still fails an insert that collides without being this submission's twin", async () => {
    const context = makeContext();
    const repository = context.deliveryRepository;
    const deliveryId = await seedInTransit(repository);

    repository.createOccurrence = async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "6.1.0",
      });
    };

    await expect(
      context.occurrence.execute({
        userId: DRIVER_USER_ID,
        businessId: BUSINESS,
        deliveryId,
        occurrenceTypeId: OCCURRENCE_TYPE,
        client_submission_id: SUBMISSION,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
