import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

import { createPrismaClient } from "@/shared/database/database-client";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { registerJobHandlers } from "@/shared/jobs/job-handlers";
import { JobRunner } from "@/shared/jobs/job-runner";
import {
  DRIVER_LABEL,
  USER_LABEL,
} from "@/shared/jobs/user-anonymize/user-anonymize-job";
import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * Removing and anonymizing a driver, or a panel login, who worked
 * (plano-escala F3-27, decision D49), over real HTTP and Postgres:
 *
 *  - another company's driver is 404, like one that does not exist; a
 *    driver a route still needs is refused;
 *  - the USER_ANONYMIZE job leaves no personal data anywhere: a scan of
 *    every text column of every table finds none of the person's name,
 *    documents, e-mail or phone (the audit trail's text included);
 *  - the history stays whole: the deliveries, the events, the messages,
 *    under the anonymous author;
 *  - the login no longer signs in, its sessions and devices are gone, the
 *    hot trail is gone, the phone on the events is gone, and the archive
 *    lists the driver for a restore to leave out;
 *  - a panel login with records goes the same way, under the delete's rules
 *    of who may remove whom.
 */
const prisma = createPrismaClient() as PrismaClient;

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe270-0000-7000-8000-00000000000a";
const OTHER = "018fe270-0000-7000-8000-00000000000b";

const PERSON = {
  name: "Joaquina Zzpii Pereira",
  cpf: "98765432100",
  cnh: "45678912300",
  rg: "MG7654321",
  email: `joaquina-${randomUUID()}@exemplo.com.br`,
  phone: "+5511988887777",
};

let fleet: FleetDriverSeed;
let other: FleetDriverSeed;
let routeId: string;
let deliveryId: string;

const anonymizeDriver = (driverId: string, businessId: string, token: string) =>
  app.inject({
    method: "POST",
    url: `/driver/anonymize-driver/${driverId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });

async function runJobs(): Promise<number> {
  const runner = new JobRunner({
    store: new BackgroundJobRepository(prisma),
    owner: () => "e2e",
  });

  registerJobHandlers(runner);

  return runner.processBatch();
}

/** Rows of every table whose text holds one of `terms`, by table. */
async function piiScan(terms: string[]): Promise<Record<string, number>> {
  const columns = await prisma.$queryRaw<
    Array<{ table: string; column: string; type: string }>
  >`
    SELECT c.relname::text AS "table", a.attname::text AS "column",
           format_type(a.atttypid, NULL) AS "type"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
      AND format_type(a.atttypid, NULL) IN
        ('text', 'character varying', 'jsonb', 'json', 'text[]')
  `;
  const found: Record<string, number> = {};

  for (const { table, column } of columns) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}"
        WHERE "${column}"::text ILIKE ANY ($1::text[])`,
      terms.map((term) => `%${term}%`),
    );

    if (row.n > 0) found[`${table}.${column}`] = row.n;
  }

  return found;
}

beforeAll(async () => {
  // The app first: it registers the container the seed's uploads use.
  ({ app } = await import("@/http"));
  await app.ready();

  fleet = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
  });

  // The person, with every kind of personal data the platform keeps.
  await prisma.driver.update({
    where: { id: fleet.driverId },
    data: {
      name: PERSON.name,
      cpf: PERSON.cpf,
      cnh: PERSON.cnh,
      rg: PERSON.rg,
      street: "Rua da Joaquina",
    },
  });
  await prisma.user.update({
    where: { id: fleet.driverUserId },
    data: {
      name: PERSON.name,
      email: PERSON.email,
      whatsapp_phone: PERSON.phone,
      avatar: `avatars/${fleet.driverUserId}/me.jpg`,
    },
  });

  const uploads = container.resolve<UploadService>("UploadService");

  await uploads.putObject(
    `avatars/${fleet.driverUserId}/1700000000000-me-x.jpg`,
    fakeJpeg(),
    "image/jpeg",
  );

  await prisma.pushDeviceToken.create({
    data: {
      userId: fleet.driverUserId,
      token: `ExponentPushToken[${randomUUID()}]`,
      platform: "android",
    },
  });
  await prisma.forgotPasswordVerificationToken.create({
    data: {
      email: PERSON.email,
      token: randomUUID(),
      expires: new Date(Date.now() + 60_000),
    },
  });

  // Work: a route, a delivery and its events, a message, the trail.
  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: shipper.id,
      driverId: fleet.driverId,
      status: "DELIVERED",
    },
  });

  deliveryId = delivery.id;

  const route = await prisma.route.create({
    data: {
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: new Date(),
      businessId: CARRIER,
      driverId: fleet.driverId,
      vehicleId: fleet.vehicleId,
    },
  });

  routeId = route.id;

  for (let n = 0; n < 3; n += 1) {
    await prisma.deliveryEvent.create({
      data: {
        type: "STATUS_CHANGE",
        deliveryId,
        businessId: CARRIER,
        routeId,
        reportedById: fleet.driverUserId,
        device: "Moto G (Android 14)",
        device_id: `android-${PERSON.cpf}`,
      },
    });
  }

  const thread = await prisma.chatThread.create({
    data: { businessId: CARRIER, driverId: fleet.driverId },
  });

  await prisma.chatMessage.create({
    data: {
      kind: "TEXT",
      body: "Cheguei no cliente",
      threadId: thread.id,
      senderId: fleet.driverUserId,
    },
  });

  await prisma.activity.create({
    data: {
      type: "Motorista",
      action: "create",
      entityId: fleet.driverId,
      description: `Motorista criado: ${PERSON.name} | CNH: ${PERSON.cnh} | ID: ${fleet.driverId}`,
      status: "Ativo",
      businessId: CARRIER,
    },
  });
  await prisma.notification.create({
    data: {
      type: "info",
      title: "Olá",
      message: `Bem-vinda, ${PERSON.name}`,
      userId: fleet.driverUserId,
      businessId: CARRIER,
    },
  });
  await prisma.driverLastPosition.create({
    data: {
      driverId: fleet.driverId,
      businessId: CARRIER,
      latitude: -23.5,
      longitude: -46.6,
      recorded_at: new Date(),
    },
  });
  await prisma.$executeRaw`
    INSERT INTO "driver_position_v2"
      ("driverId", "businessId", "latitude", "longitude", "recorded_at")
    SELECT ${fleet.driverId}::uuid, ${CARRIER}::uuid, -23.5, -46.6,
           date_trunc('second', now() AT TIME ZONE 'UTC') - make_interval(secs => n)
    FROM generate_series(1, 20) AS n
  `;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("removing and anonymizing a driver", () => {
  it("answers another company's driver as one that does not exist", async () => {
    const theirs = await anonymizeDriver(
      other.driverId,
      CARRIER,
      fleet.managerToken,
    );

    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().code).toBe("DRIVER_NOT_FOUND");

    // Their company in the path: the tenant guard.
    const crossed = await anonymizeDriver(
      fleet.driverId,
      OTHER,
      fleet.managerToken,
    );

    expect(crossed.statusCode).toBe(403);
    expect(
      await prisma.backgroundJob.count({ where: { kind: "USER_ANONYMIZE" } }),
    ).toBe(0);
  });

  it("refuses a driver a route still needs", async () => {
    const refused = await anonymizeDriver(
      fleet.driverId,
      CARRIER,
      fleet.managerToken,
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("DRIVER_HAS_OPEN_ROUTES");

    await prisma.route.update({
      where: { id: routeId },
      data: { status: "COMPLETED" },
    });
  });

  it("takes every personal datum and keeps the history", async () => {
    const accepted = await anonymizeDriver(
      fleet.driverId,
      CARRIER,
      fleet.managerToken,
    );

    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(accepted.json().jobId).toEqual(expect.any(String));

    // Asked again before it ran: the same job.
    const again = await anonymizeDriver(
      fleet.driverId,
      CARRIER,
      fleet.managerToken,
    );

    expect(again.json().jobId).toBe(accepted.json().jobId);

    expect(await runJobs()).toBe(1);

    expect(
      await prisma.backgroundJob.findUniqueOrThrow({
        where: { id: accepted.json().jobId },
      }),
    ).toMatchObject({ status: "SUCCEEDED" });

    const driver = await prisma.driver.findUniqueOrThrow({
      where: { id: fleet.driverId },
    });

    expect(driver).toMatchObject({
      name: DRIVER_LABEL,
      rg: "",
      street: "",
      status: "INACTIVE",
    });
    expect(driver.anonymized_at).not.toBeNull();

    const login = await prisma.user.findUniqueOrThrow({
      where: { id: fleet.driverUserId },
    });

    expect(login).toMatchObject({
      name: DRIVER_LABEL,
      email: null,
      whatsapp_phone: null,
      avatar: null,
      access_revoked: true,
    });

    // Signed out: no session, no device, no photo, no position.
    for (const count of [
      prisma.refreshToken.count({ where: { userId: fleet.driverUserId } }),
      prisma.pushDeviceToken.count({ where: { userId: fleet.driverUserId } }),
      prisma.notification.count({ where: { userId: fleet.driverUserId } }),
      prisma.driverLastPosition.count({ where: { driverId: fleet.driverId } }),
    ]) {
      expect(await count).toBe(0);
    }

    const avatars = await container
      .resolve<UploadService>("UploadService")
      .listObjectKeys(`avatars/${fleet.driverUserId}/`);

    expect(avatars).toEqual([]);

    const [trail] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "driver_position_v2"
      WHERE "driverId" = ${fleet.driverId}::uuid
    `;

    expect(trail.n).toBe(0);

    // The history, whole, under the anonymous author.
    const events = await prisma.deliveryEvent.findMany({
      where: { deliveryId },
    });

    expect(events).toHaveLength(3);
    expect(
      events.every(
        (event) =>
          event.reportedById === fleet.driverUserId &&
          event.device === null &&
          event.device_id === null,
      ),
    ).toBe(true);
    expect(
      await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ driverId: fleet.driverId, status: "DELIVERED" });
    expect(
      await prisma.chatMessage.count({
        where: { senderId: fleet.driverUserId },
      }),
    ).toBe(1);

    // The archive's restore leaves the driver out.
    expect(
      await prisma.trailArchiveRedaction.findUnique({
        where: { driverId: fleet.driverId },
      }),
    ).toMatchObject({ businessId: CARRIER });
  });

  it("leaves none of the person's data in any table", async () => {
    expect(
      await piiScan([
        PERSON.name,
        "Joaquina",
        PERSON.cpf,
        PERSON.cnh,
        PERSON.rg,
        PERSON.email,
        PERSON.phone,
        "Rua da Joaquina",
      ]),
    ).toEqual({});
  });

  it("refuses a second removal of the same driver", async () => {
    const twice = await anonymizeDriver(
      fleet.driverId,
      CARRIER,
      fleet.managerToken,
    );

    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("DRIVER_ALREADY_ANONYMIZED");
  });
});

describe("removing and anonymizing a panel login", () => {
  const anonymizeUser = (userId: string, token: string) =>
    app.inject({
      method: "POST",
      url: `/user/anonymize-user/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("answers another company's login as one that does not exist", async () => {
    const theirs = await seedUser(prisma, OTHER, "BUSINESS_USER");
    const response = await anonymizeUser(theirs.id, fleet.managerToken);

    expect(response.statusCode).toBe(404);
  });

  it("sends a driver's login to the driver's removal", async () => {
    const response = await anonymizeUser(
      other.driverUserId,
      other.managerToken,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("USER_IS_DRIVER_LOGIN");
  });

  it("anonymizes a login with records and keeps them", async () => {
    const clerk = await seedUser(prisma, CARRIER, "BUSINESS_USER");
    const email = `clerk-${randomUUID()}@exemplo.com.br`;

    await prisma.user.update({
      where: { id: clerk.id },
      data: { name: "Zzclerk Silvana", email },
    });
    await prisma.deliveryEvent.create({
      data: {
        type: "STATUS_CHANGE",
        deliveryId,
        businessId: CARRIER,
        reportedById: clerk.id,
      },
    });

    const response = await anonymizeUser(clerk.id, fleet.managerToken);

    expect(response.statusCode, response.body).toBe(202);
    expect(await runJobs()).toBe(1);

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: clerk.id } }),
    ).toMatchObject({ name: USER_LABEL, email: null, access_revoked: true });
    expect(
      await prisma.deliveryEvent.count({ where: { reportedById: clerk.id } }),
    ).toBe(1);
    expect(await piiScan(["Zzclerk", email])).toEqual({});
  });
});
