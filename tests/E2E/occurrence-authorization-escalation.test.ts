import "@/shared";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { container } from "tsyringe";

import { OccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/occurrence-authorization-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { escalateOccurrenceAuthorizationsJob } from "@/jobs/cron/escalate-occurrence-authorizations-job";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import {
  deliveryOccurrenceAuthorizationEscalatedPolicy,
  deliveryOccurrenceAuthorizationRequestedPolicy,
  deliveryOccurrenceReportedPolicy,
} from "@/shared/notifications/policies/delivery-occurrence-policy";

import type {
  DeliveryOccurrenceAuthorizationEscalatedPayload,
  PolicyDeps,
} from "@/shared/notifications/notification-types";

/**
 * Decision 6.3 on Postgres: a request nobody answered in ten minutes goes to
 * the administrators ONCE — with two replicas sweeping at the same time, and
 * with the sweep repeated. And the people each notice reaches (DLVP-NOTIF-1):
 * the tower's operators hear the requests and the insucessos, only the
 * administrators hear the escalation.
 */
const prisma = new PrismaClient();

// Two replicas: separate pools, separate connections, one database.
const replicaA = new PrismaClient();
const replicaB = new PrismaClient();

const CARRIER = "018fea00-0000-7000-8000-00000000000a";
const OTHER = "018fea00-0000-7000-8000-00000000000b";
const SHIPPER = "018fea00-0000-7000-8000-0000000000f1";
const DRIVER = "018fea00-0000-7000-8000-0000000000d1";
const TYPE = "018fea00-0000-7000-8000-0000000000e1";

const MINUTE = 60_000;

const ids: Record<string, string> = {};

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedUser(
  key: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string,
  extra: {
    profileAccessId?: string;
    driverId?: string;
    revoked?: boolean;
    minutes?: number;
  } = {},
): Promise<void> {
  const user = await prisma.user.create({
    data: {
      name: key,
      email: `${key}.${randomUUID()}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
      access_revoked: extra.revoked ?? false,
      created_at: new Date(Date.UTC(2026, 0, 1, 12, extra.minutes ?? 0)),
    },
  });

  ids[key] = user.id;
}

async function profileWith(
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  return profile.id;
}

/** A report that asked the tower `minutesAgo` minutes ago. */
async function request(
  minutesAgo: number,
  status: "PENDING" | "DENIED" = "PENDING",
  escalatedAt: Date | null = null,
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${minutesAgo} min`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: DRIVER,
      status: "IN_TRANSIT",
    },
  });

  const occurrence = await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: delivery.id,
      businessId: CARRIER,
      occurrenceTypeId: TYPE,
      reportedById: ids.driver,
      authorization_status: status,
      escalated_at: escalatedAt,
      form_answers: { quem_atendeu: "Porteiro" },
      form_version: 1,
      created_at: new Date(Date.now() - minutesAgo * MINUTE),
    },
  });

  return occurrence.id;
}

const escalationsOf = (occurrenceId: string) =>
  prisma.domainOutboxEvent.findMany({
    where: {
      topic: "delivery-occurrence.authorization_escalated",
      eventKey: `delivery-occurrence.authorization_escalated:${occurrenceId}`,
    },
  });

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-esc-1",
      cpf: "cpf-esc-1",
      rg: "rg-esc-1",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  const writes = await profileWith("delivery_manage", true);
  const reads = await profileWith("delivery_manage", false);
  const fleet = await profileWith("vehicle_manage", true);

  await seedUser("admin", "BUSINESS_ADMIN", CARRIER, { minutes: 1 });
  await seedUser("operator", "BUSINESS_USER", CARRIER, {
    profileAccessId: writes,
    minutes: 2,
  });
  await seedUser("reader", "BUSINESS_USER", CARRIER, {
    profileAccessId: reads,
    minutes: 3,
  });
  await seedUser("fleet", "BUSINESS_USER", CARRIER, {
    profileAccessId: fleet,
    minutes: 4,
  });
  await seedUser("revoked", "BUSINESS_USER", CARRIER, {
    profileAccessId: writes,
    revoked: true,
    minutes: 5,
  });
  // The driver holds delivery_manage for the app and must never be an operator.
  await seedUser("driver", "BUSINESS_USER", CARRIER, {
    driverId: DRIVER,
    profileAccessId: writes,
    minutes: 6,
  });
  await seedUser("admin2", "BUSINESS_ADMIN", CARRIER, { minutes: 7 });
  await seedUser("otherAdmin", "BUSINESS_ADMIN", OTHER, { minutes: 8 });

  await prisma.occurrenceType.create({
    data: {
      id: TYPE,
      name: "Cliente ausente (torre)",
      blocks_delivery: true,
      requires_authorization: true,
      form_fields: [
        {
          key: "quem_atendeu",
          label: "Quem atendeu",
          type: "text",
          required: true,
          max_length: 60,
          multiline: false,
        },
      ],
      businessId: CARRIER,
    },
  });
}, 120_000);

afterAll(async () => {
  await Promise.all([
    prisma.$disconnect(),
    replicaA.$disconnect(),
    replicaB.$disconnect(),
  ]);
});

describe("two replicas sweeping at the same instant", () => {
  it("claim each due request once, and never a young, decided or escalated one", async () => {
    const due = [await request(11), await request(25)];
    const young = await request(5);
    const decided = await request(30, "DENIED");
    const already = await request(
      40,
      "PENDING",
      new Date(Date.now() - 20 * MINUTE),
    );

    const now = new Date();
    const cutoff = new Date(now.getTime() - 10 * MINUTE);

    // Each replica holds its claim open for a moment, so the other's claim
    // runs while the first one's row locks are still held.
    const sweep = (client: PrismaClient) =>
      client.$transaction(async (tx) => {
        const rows = await new OccurrenceAuthorizationRepository(
          client,
        ).claimDueEscalations(cutoff, 100, now, tx);

        await tx.$executeRaw`SELECT pg_sleep(0.3)`;

        return rows.map((row) => row.id);
      });

    const [claimedByA, claimedByB] = await Promise.all([
      sweep(replicaA),
      sweep(replicaB),
    ]);

    const claimed = [...claimedByA, ...claimedByB];

    expect(claimed.sort()).toEqual([...due].sort());
    expect(new Set(claimed).size).toBe(claimed.length);

    const rows = await prisma.deliveryOccurrence.findMany({
      where: { id: { in: [...due, young, decided, already] } },
      select: { id: true, escalated_at: true },
    });

    const escalatedAt = new Map(rows.map((row) => [row.id, row.escalated_at]));

    for (const id of due) expect(escalatedAt.get(id)).toBeInstanceOf(Date);
    expect(escalatedAt.get(young)).toBeNull();
    expect(escalatedAt.get(decided)).toBeNull();
    expect(escalatedAt.get(already)?.getTime()).toBeLessThan(
      now.getTime() - 10 * MINUTE,
    );

    // A sweep repeated later finds nothing left.
    const again = await replicaA.$transaction((tx) =>
      new OccurrenceAuthorizationRepository(replicaA).claimDueEscalations(
        cutoff,
        100,
        now,
        tx,
      ),
    );

    expect(again).toEqual([]);
  });
});

describe("the escalation job", () => {
  it("run twice at once, publishes one escalation per request, to the administrators only", async () => {
    const due = await request(12);

    await Promise.all([
      escalateOccurrenceAuthorizationsJob.handler(),
      escalateOccurrenceAuthorizationsJob.handler(),
    ]);
    await escalateOccurrenceAuthorizationsJob.handler();

    const events = await escalationsOf(due);

    expect(events).toHaveLength(1);

    const payload = events[0]
      .payload as unknown as DeliveryOccurrenceAuthorizationEscalatedPayload;

    expect(payload).toMatchObject({
      occurrenceId: due,
      businessId: CARRIER,
      occurrenceTypeName: "Cliente ausente (torre)",
      reporterName: "driver",
      answers: [{ label: "Quem atendeu", value: "Porteiro" }],
    });
    expect(payload.waitingMinutes).toBeGreaterThanOrEqual(12);

    const recipients =
      await deliveryOccurrenceAuthorizationEscalatedPolicy.resolveRecipients(
        payload,
        { userRepository: new UserRepository() } as PolicyDeps,
      );

    expect(recipients.map((user) => user.id)).toEqual([ids.admin, ids.admin2]);

    const queued = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: due },
    });

    expect(queued.escalated_at).toBeInstanceOf(Date);
    expect(queued.authorization_status).toBe("PENDING");
  });
});

describe("who the occurrence notices reach (DLVP-NOTIF-1)", () => {
  it("the tower's operators hear the requests and the insucessos, beside the administrators", async () => {
    const deps = { userRepository: new UserRepository() } as PolicyDeps;

    const requested =
      await deliveryOccurrenceAuthorizationRequestedPolicy.resolveRecipients(
        { businessId: CARRIER } as never,
        deps,
      );
    const failed = await deliveryOccurrenceReportedPolicy.resolveRecipients(
      { businessId: CARRIER } as never,
      deps,
    );

    // Admins and the writer of delivery_manage; not the reader, the fleet
    // profile, the revoked account, the driver or the other company.
    const expected = [ids.admin, ids.operator, ids.admin2];

    expect(requested.map((user) => user.id)).toEqual(expected);
    expect(failed.map((user) => user.id)).toEqual(expected);
  });
});

describe("a request whose delivery was resolved from the panel (review r1)", () => {
  it("is closed by the sweep and never escalated, and leaves the queue at once", async () => {
    const cancelledId = await request(12);
    const waitingId = await request(13);

    const { deliveryId } = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: cancelledId },
      select: { deliveryId: true },
    });

    const reason = await prisma.statusChangeReason.create({
      data: {
        name: `Cancelada ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
      },
    });

    // The panel's own path: nothing in it knows about the request.
    await container.resolve(UpdateDeliveryStatusUseCase).execute({
      userId: ids.admin,
      businessId: CARRIER,
      deliveryId,
      status: "CANCELLED",
      reasonId: reason.id,
    });

    const queue = await new OccurrenceAuthorizationRepository(
      prisma,
    ).listPending(CARRIER, 100);

    expect(queue.rows.map((row) => row.id)).not.toContain(cancelledId);
    expect(queue.rows.map((row) => row.id)).toContain(waitingId);

    await escalateOccurrenceAuthorizationsJob.handler();

    expect(await escalationsOf(cancelledId)).toHaveLength(0);
    expect(await escalationsOf(waitingId)).toHaveLength(1);

    const closed = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: cancelledId },
    });

    expect(closed).toMatchObject({
      authorization_status: "SUPERSEDED",
      escalated_at: null,
    });

    // Repeated, the sweep finds nothing more to close or escalate.
    await escalateOccurrenceAuthorizationsJob.handler();

    expect(await escalationsOf(waitingId)).toHaveLength(1);
  });
});

/**
 * Tickets design §5.2: when the sweep closes a request as SUPERSEDED, the
 * occurrence's ticket says so in its trail and moves its version, and stays
 * OPEN — closing is a person's act with a name.
 */
describe("the ticket of a request the sweep superseded", () => {
  it("gets an AUTHORIZATION_SUPERSEDED line and a new version, and stays open", async () => {
    const occurrenceId = await request(14);

    const { deliveryId } = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      select: { deliveryId: true },
    });

    const thread = await prisma.chatThread.upsert({
      where: { businessId_driverId: { businessId: CARRIER, driverId: DRIVER } },
      create: { businessId: CARRIER, driverId: DRIVER },
      update: {},
    });

    const ticket = await prisma.supportTicket.create({
      data: {
        number: 900_000 + Math.floor(Math.random() * 99_999),
        kind: "OCCURRENCE",
        subject: "Cliente ausente — teste",
        businessId: CARRIER,
        threadId: thread.id,
        driverId: DRIVER,
        deliveryId,
        occurrenceId,
        opened_via: "OCCURRENCE_REPORT",
      },
    });

    // The attempt ends from the panel, by a path that knows nothing of tickets.
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "DELIVERED" },
    });

    await escalateOccurrenceAuthorizationsJob.handler();

    expect(
      await prisma.deliveryOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
      }),
    ).toMatchObject({ authorization_status: "SUPERSEDED" });

    const after = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    });

    expect(after.status).toBe("OPEN");
    expect(after.version).toBe(ticket.version + 1);

    const events = await prisma.supportTicketEvent.findMany({
      where: { ticketId: ticket.id },
    });

    expect(events.map((event) => [event.type, event.actor_kind])).toEqual([
      ["AUTHORIZATION_SUPERSEDED", "SYSTEM"],
    ]);

    // Run again: nothing more is superseded, nothing more is written.
    await escalateOccurrenceAuthorizationsJob.handler();

    expect(
      await prisma.supportTicketEvent.count({ where: { ticketId: ticket.id } }),
    ).toBe(1);
  });
});
