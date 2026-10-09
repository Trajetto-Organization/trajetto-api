import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

/**
 * The work the resilience tests put in front of the replicas: one carrier,
 * an administrator reachable by bell, e-mail and WhatsApp, a driver with a
 * phone registered for push, webhook endpoints and queued AI readings.
 *
 * Events are written straight into the outbox, as `OutboxService.publish(tx)`
 * leaves them after the business transaction commits: what is under test is
 * everything AFTER that commit.
 */
interface ResilienceSeed {
  businessId: string;
  adminId: string;
  driverUserId: string;

  /** The admin's access token, for the HTTP probes. */
  adminToken: string;
}

async function seedResilienceTenant(prisma: PrismaClient, businessId: string): Promise<ResilienceSeed> {
  const adminId = randomUUID();
  const driverUserId = randomUUID();

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: "Transportadora Resiliente",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33444555000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `resiliente-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: adminId,
      name: "Administradora",
      email: `admin-${adminId}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  await prisma.user.create({
    data: {
      id: driverUserId,
      name: "Motorista",
      email: `motorista-${driverUserId}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId,
    },
  });

  await prisma.pushDeviceToken.create({
    data: {
      userId: driverUserId,
      token: `ExponentPushToken[${randomUUID()}]`,
      platform: "android",
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: adminId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const adminToken = sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: adminId,
    expiresIn: "1h",
  });

  return { businessId, adminId, driverUserId, adminToken };
}

/** An account payable assigned to the admin: bell, activity, e-mail, WhatsApp. */
async function publishAccountPayables(prisma: PrismaClient, seed: ResilienceSeed, count: number): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const accountPayableId = randomUUID();
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `account-payable.created:${accountPayableId}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: accountPayableId,
        businessId: seed.businessId,
        actorId: seed.adminId,
        payload: {
          accountPayableId,
          businessId: seed.businessId,
          amount: 100 + index,
          serviceOrderId: null,
          registrationUserId: seed.adminId,
        },
      },
    });

    ids.push(event.id);
  }

  return ids;
}

/** A released route: one push to the driver's phone. */
async function publishRouteReleases(prisma: PrismaClient, seed: ResilienceSeed, count: number): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const routeId = randomUUID();
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `route.released:${routeId}`,
        topic: "route.released",
        aggregateType: "route",
        aggregateId: routeId,
        businessId: seed.businessId,
        actorId: seed.adminId,
        payload: {
          routeId,
          businessId: seed.businessId,
          driverUserId: seed.driverUserId,
          code: 1000 + index,
          routeName: null,
          stopCount: 3,
          scheduledLabel: "hoje",
        },
      },
    });

    ids.push(event.id);
  }

  return ids;
}

/** `events` rows per endpoint, queued as the fan-out queues them. */
async function queueWebhookRows(
  prisma: PrismaClient,
  seed: ResilienceSeed,
  receiverUrl: string,
  endpoints: number,
  events: number,
): Promise<string[]> {
  const { fanOutWebhookEvent } = await import("@/shared/integration/webhook-dispatch-service");

  for (let index = 0; index < endpoints; index += 1) {
    await prisma.webhookEndpoint.create({
      data: {
        name: `Receptor ${index}`,
        url: `${receiverUrl}/hook/${index}`,
        secret: "whsec_teste_de_resiliencia",
        topics: ["delivery.delivered"],
        businessId: seed.businessId,
      },
    });
  }

  for (let index = 0; index < events; index += 1) {
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: seed.businessId,
      payload: { delivery_id: randomUUID(), code: `PED-${index}` },
    });
  }

  const rows = await prisma.webhookDelivery.findMany({ select: { id: true } });

  return rows.map((row) => row.id);
}

/**
 * Leases are minutes long (180 s for a delivery, 300 s for an AI request); a
 * test does not wait them out. Moving the clock of the PROCESSING rows is the
 * same thing a lease running out is, seen from the claim — which reads only
 * `leaseExpiresAt` / `availableAt` against the database's now().
 */
async function expireLeases(prisma: PrismaClient): Promise<void> {
  for (const table of ["notification_delivery", "domain_outbox_event", "webhook_delivery", "ai_analysis_request"]) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "leaseExpiresAt" = now() - interval '1 second'
       ${table === "domain_outbox_event" ? "" : `, "availableAt" = LEAST("availableAt", now() - interval '1 second')`}
       WHERE "status" = 'PROCESSING'`,
    );
  }
}

/** Retries scheduled in the future, made due now (backoff is not under test). */
async function makeRetriesDue(prisma: PrismaClient): Promise<void> {
  for (const table of ["notification_delivery", "domain_outbox_event", "webhook_delivery", "ai_analysis_request"]) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "availableAt" = now() - interval '1 second' WHERE "status" = 'PENDING'`,
    );
  }
}

interface QueueState {
  open: number;
  processing: number;
}

/** Rows not yet settled, per queue. */
async function openWork(prisma: PrismaClient): Promise<Record<string, QueueState>> {
  const result: Record<string, QueueState> = {};

  for (const table of ["domain_outbox_event", "notification_delivery", "webhook_delivery", "ai_analysis_request"]) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ open: bigint; processing: bigint }>>(
      `SELECT count(*) FILTER (WHERE "status" IN ('PENDING','PROCESSING')) AS open,
              count(*) FILTER (WHERE "status" = 'PROCESSING') AS processing
       FROM "${table}"`,
    );

    result[table] = { open: Number(row.open), processing: Number(row.processing) };
  }

  return result;
}

async function waitUntilSettled(prisma: PrismaClient, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, QueueState> = {};

  for (;;) {
    last = await openWork(prisma);

    if (Object.values(last).every((state) => state.open === 0)) return;

    if (Date.now() > deadline) {
      throw new Error(`${what}: trabalho em aberto depois de ${timeoutMs} ms: ${JSON.stringify(last)}`);
    }

    await new Promise((done) => setTimeout(done, 250));
  }
}

export {
  expireLeases,
  makeRetriesDue,
  openWork,
  publishAccountPayables,
  publishRouteReleases,
  queueWebhookRows,
  seedResilienceTenant,
  waitUntilSettled,
};
export type { ResilienceSeed };

/**
 * Fuelings whose odometer photo waits for the local OCR, each with its unit
 * reserved on the company's quota — what AIAnalysisService leaves queued.
 */
async function queueFuelReadings(
  prisma: PrismaClient,
  fleet: { businessId: string; branchId: string; vehicleId: string; driverId: string; fuelTypeId: string; driverUserId: string },
  periodId: string,
  count: number,
): Promise<Array<{ requestId: string; fuelId: string }>> {
  const queued: Array<{ requestId: string; fuelId: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const photo = `odometerPhotos/${fleet.businessId}/${randomUUID()}.jpg`;

    const fuel = await prisma.fuel.create({
      data: {
        current_mileage: 1000,
        liters_amount: 50,
        price_per_liter: 6,
        total_amount: 300,
        odometer_photo: photo,
        odometer_ai_status: "pending",
        businessId: fleet.businessId,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
        fuelTypeId: fleet.fuelTypeId,
      },
    });

    const request = await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "FUEL_ODOMETER",
        recordId: fuel.id,
        businessId: fleet.businessId,
        periodId,
        requestedById: fleet.driverUserId,
        input: { odometerPhotoPath: photo, reportedMileage: 1000 },
      },
    });

    await prisma.aIAnalysisUnit.create({ data: { requestId: request.id, unitKey: "odometer" } });
    await prisma.aIUsagePeriod.update({ where: { id: periodId }, data: { reservedUnits: { increment: 1 } } });

    queued.push({ requestId: request.id, fuelId: fuel.id });
  }

  return queued;
}

export { queueFuelReadings };
