import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type pg from "pg";
import { container } from "tsyringe";

import { openReleaseClient } from "infra/scripts/release-connection";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedLogin } from "./support/driver-access-seed";
import { fakeJpeg, seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * The runtime after the cut of the database roles, end to end (plano-escala
 * F3-21).
 *
 * The API connects today as the owner of every table. After the cut the
 * requests, the workers and the cron of the papel `all` run as two logins:
 * one in trajetto_http (DATABASE_URL), one in trajetto_batch
 * (BATCH_DATABASE_URL), with only the grants of
 * infra/sql/20-runtime-roles.sql. Anything the product does that those
 * grants forgot would fail in production with 42501 on the day the owner
 * switches the URLs — so the paths a working day goes through run here, as
 * those two logins, and each must answer 2xx: login and refresh, a delivery
 * created from the panel, the driver's positions, the proof and its
 * document (the GPS address cached on the trail, the one UPDATE the
 * runtime may do there), a webhook created and delivered, the notifications
 * drained and read, a spreadsheet imported and undone (the trail's CASCADE
 * runs as the table's owner), and the nightly partition job as the batch
 * login. Then the boot's own check, against these logins and the owner.
 *
 * The two logins are made here for the test (a release never gives a role
 * LOGIN) and dropped at the end: a role belongs to the cluster.
 */
const OWNER_URL = process.env.DATABASE_URL as string;
const suffix = randomBytes(4).toString("hex");
const HTTP_LOGIN = `e2e_http_${suffix}`;
const BATCH_LOGIN = `e2e_batch_${suffix}`;
const PASSWORD = randomBytes(16).toString("hex");

function urlAs(login: string): string {
  const url = new URL(OWNER_URL);

  url.username = login;
  url.password = PASSWORD;

  return url.toString();
}

// Seeds and checks go through the owner; everything the app does, through
// the logins. The app's pools read these when they first connect.
const owner = createPrismaClient({ log: [] }, { url: OWNER_URL });

const CARRIER = "018fe2a1-0000-7000-8000-00000000000a";
const EMAIL = `gestora-${suffix}@example.com`;
const LOGIN_PASSWORD = "senha-do-smoke-123";

let admin: pg.Client;
let app: Awaited<typeof import("@/http")>["app"];
let receiver: Server;
let receiverUrl = "";
const received: string[] = [];

let fleet: Awaited<ReturnType<typeof seedFleetDriver>>;
let shipperId = "";
let localEndpointId = "";

beforeAll(async () => {
  admin = await openReleaseClient(OWNER_URL, "e2e-runtime-role-admin");

  // Test-only logins, members of the runtime's roles and of nothing else.
  await admin.query(
    `CREATE ROLE ${HTTP_LOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER IN ROLE trajetto_http`,
  );
  await admin.query(
    `CREATE ROLE ${BATCH_LOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER IN ROLE trajetto_batch`,
  );

  process.env.DATABASE_URL = urlAs(HTTP_LOGIN);
  process.env.BATCH_DATABASE_URL = urlAs(BATCH_LOGIN);

  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200).end("ok");
    });
  });

  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );

  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  fleet = await seedFleetDriver(owner, {
    businessId: CARRIER,
    cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
  });

  shipperId = (
    await owner.shipper.create({
      data: { name: "Embarcador do Smoke", businessId: CARRIER },
    })
  ).id;

  await seedLogin(owner, {
    businessId: CARRIER,
    role: "BUSINESS_ADMIN",
    email: EMAIL,
    password: LOGIN_PASSWORD,
  });

  // The customer's ERP, so a delivered proof queues a webhook.
  localEndpointId = (
    await owner.webhookEndpoint.create({
      data: {
        name: "ERP local",
        url: receiverUrl,
        secret: "whsec_teste_do_smoke",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
      },
    })
  ).id;

  await owner.route.create({
    data: {
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: new Date(),
      started_at: new Date(Date.now() - 10 * 60_000),
      businessId: CARRIER,
      driverId: fleet.driverId,
      vehicleId: fleet.vehicleId,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();

  const database = await import("@/../infra/database");

  await database.default.$disconnect();
  await database.databaseBatch.$disconnect();
  await owner.$disconnect();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));

  process.env.DATABASE_URL = OWNER_URL;
  delete process.env.BATCH_DATABASE_URL;

  for (const login of [HTTP_LOGIN, BATCH_LOGIN]) {
    await admin.query(`DROP OWNED BY ${login}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
  }

  await admin.end();
}, 60_000);

const asManager = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${fleet.managerToken}` },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

describe("the runtime as trajetto_http and trajetto_batch", () => {
  it("really runs as the two logins, not as the owner", async () => {
    const database = await import("@/../infra/database");

    const [http] = await database.default.$queryRaw<Array<{ user: string }>>`
      SELECT session_user::text AS "user"
    `;
    const [batch] = await database.databaseBatch.$queryRaw<
      Array<{ user: string }>
    >`SELECT session_user::text AS "user"`;

    expect(http.user).toBe(HTTP_LOGIN);
    expect(batch.user).toBe(BATCH_LOGIN);
  });

  it("runs the nightly partition job as the batch login", async () => {
    const { maintainPartitions } =
      await import("@/jobs/cron/partition-maintenance-job");

    const outcome = await maintainPartitions();

    expect(outcome.driver_position).toMatchObject({
      ownerOk: true,
      missingNow: [],
    });
  });

  it("logs in and refreshes the session", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/user/session",
      remoteAddress: "10.91.0.1",
      payload: { email: EMAIL, password: LOGIN_PASSWORD },
    });

    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().token).toEqual(expect.any(String));

    const refreshed = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: "10.91.0.1",
      payload: { token: login.json().refresh_token },
    });

    expect(refreshed.statusCode, refreshed.body).toBe(200);
  });

  it("creates a delivery from the panel", async () => {
    const created = await asManager(
      "POST",
      `/delivery/create-delivery/${CARRIER}`,
      {
        shipperId,
        recipient_name: "Padaria do Smoke",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
      },
    );

    expect(created.statusCode, created.body).toBe(201);
  });

  it("stores the driver's positions", async () => {
    const now = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: { authorization: `Bearer ${fleet.driverToken}` },
      payload: {
        pings: [0, 1, 2].map((index) => ({
          latitude: -23.55 + index * 0.0001,
          longitude: -46.63 + index * 0.0001,
          accuracy: 10,
          speed: 30,
          heading: 90,
          battery: 80,
          recorded_at: new Date(now - (3 - index) * 15_000).toISOString(),
        })),
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ stored: 3 });
  });

  it("proves a delivery, renders its document and caches the GPS address", async () => {
    const { UploadService } = await import("@/shared/services/upload-service");
    const uploads =
      container.resolve<InstanceType<typeof UploadService>>("UploadService");
    const stored = async () => {
      const key = `deliveryPhotos/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

      await uploads.putObject(key, fakeJpeg(), "image/jpeg");

      return key;
    };

    const delivery = await owner.delivery.create({
      data: {
        recipient_name: "Mercado do Smoke",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: CARRIER,
        shipperId,
        driverId: fleet.driverId,
        status: "IN_TRANSIT",
      },
    });

    const proof = await app.inject({
      method: "POST",
      url: `/delivery/proof/${delivery.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${fleet.driverToken}` },
      payload: {
        client_submission_id: randomUUID(),
        photo: await stored(),
        signature: await stored(),
        received_by: "Maria (portaria)",
        latitude: -23.5505,
        longitude: -46.6333,
      },
    });

    expect(proof.statusCode, proof.body).toBe(201);

    const document = await asManager(
      "GET",
      `/delivery/proof-document/${delivery.id}/business/${CARRIER}`,
    );

    expect(document.statusCode, document.body).toBe(200);

    // The one UPDATE the runtime may do on the trail, by the same
    // repository the document uses, on the app's client.
    const event = await owner.deliveryEvent.findFirstOrThrow({
      where: { deliveryId: delivery.id, type: "PROOF" },
    });
    const { ProofDocumentRepository } =
      await import("@/modules/delivery/repositories/proof-document-repository");
    const database = await import("@/../infra/database");
    const at = new Date();

    await new ProofDocumentRepository(database.default).saveGpsAddress(
      event.id,
      CARRIER,
      {
        gps_address: null,
        gps_address_source: "UNAVAILABLE",
        gps_geocoded_at: at,
      },
    );

    expect(
      (await owner.deliveryEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .gps_geocoded_at,
    ).toEqual(at);
  });

  it("creates a webhook endpoint and delivers the proof's webhook", async () => {
    const created = await asManager(
      "POST",
      `/integrations/webhook-endpoint/${CARRIER}`,
      {
        name: "ERP na nuvem",
        url: "https://erp.example.com/webhooks",
        topics: ["delivery.created"],
      },
    );

    expect(created.statusCode, created.body).toBe(201);

    const { WebhookDispatchService } =
      await import("@/shared/integration/webhook-dispatch-service");

    // The destination check would refuse 127.0.0.1, rightly; the delivery
    // itself is what runs here.
    await new WebhookDispatchService(async () => ({
      allowed: true,
    })).processBatch();

    expect(received.join("\n")).toContain("delivery.delivered");

    const statuses = await owner.webhookDelivery.groupBy({
      by: ["status"],
      where: { businessId: CARRIER, endpointId: localEndpointId },
      _count: true,
    });

    expect(statuses).toEqual([
      expect.objectContaining({ status: "DELIVERED" }),
    ]);
  });

  it("drains the notifications and reads them", async () => {
    const { NotificationPipelineService } =
      await import("@/shared/notifications/notification-pipeline-service");
    const pipeline = NotificationPipelineService.getInstance();

    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");

    const refused = await owner.$queryRaw<Array<{ count: number }>>`
      SELECT (
        (SELECT count(*) FROM "domain_outbox_event" WHERE "lastError" ILIKE '%permission denied%')
        + (SELECT count(*) FROM "notification_delivery" WHERE "lastError" ILIKE '%permission denied%')
      )::int AS "count"
    `;

    expect(refused[0].count).toBe(0);

    const unread = await asManager("GET", "/notification/unread-count");

    expect(unread.statusCode, unread.body).toBe(200);

    const read = await asManager("PATCH", "/notification/read-all");

    expect(read.statusCode, read.body).toBeLessThan(300);
  });

  it("imports a spreadsheet and undoes it", async () => {
    const { importQueue } =
      await import("@/modules/import/services/import-queue");
    // The model's columns (import-http.test.ts), with no route.
    const header = [
      "Destinatário",
      "CEP",
      "Cidade",
      "UF",
      "Logradouro",
      "Pedido",
      "Rota",
      "CNH do motorista",
    ];
    const rows = ["PED-S1", "PED-S2"].map((code) => [
      `Cliente ${code}`,
      "01001000",
      "São Paulo",
      "SP",
      "Praça da Sé",
      code,
      "",
      "",
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(";"))
      .join("\n");

    const accepted = await asManager(
      "POST",
      `/import/import-spreadsheet/${CARRIER}`,
      {
        filename: `carga-${suffix}.csv`,
        content: Buffer.from(csv, "utf8").toString("base64"),
        shipperId,
      },
    );

    expect(accepted.statusCode, accepted.body).toBe(202);

    await importQueue.idle();

    const importId = accepted.json().data.id;
    const detail = await asManager(
      "GET",
      `/import/get-import/${importId}/business/${CARRIER}`,
    );

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.imported).toBe(2);

    // The undo deletes the deliveries: their trail goes by the foreign
    // key's CASCADE, which Postgres runs as the table's owner.
    const undone = await asManager(
      "POST",
      `/import/reverse-import/${importId}/business/${CARRIER}`,
    );

    expect(undone.statusCode, undone.body).toBeLessThan(300);
  });

  it("removes and anonymizes the driver, the events' phone through the batch login", async () => {
    // plano-escala F3-27: the identity on the request login's grants, the
    // delivery trail's `device` and `device_id` only as trajetto_batch
    // (the runtime may change no other column of the trail).
    await owner.route.updateMany({
      where: { driverId: fleet.driverId },
      data: { status: "COMPLETED" },
    });
    await owner.deliveryEvent.updateMany({
      where: { businessId: CARRIER },
      data: {
        reportedById: fleet.driverUserId,
        device: "Moto G (Android 14)",
        device_id: "android-smoke",
      },
    });

    const accepted = await asManager(
      "POST",
      `/driver/anonymize-driver/${fleet.driverId}/business/${CARRIER}`,
    );

    expect(accepted.statusCode, accepted.body).toBe(202);

    const { JobRunner } = await import("@/shared/jobs/job-runner");
    const { registerJobHandlers } = await import("@/shared/jobs/job-handlers");
    const runner = new JobRunner({ owner: () => "e2e-smoke" });

    registerJobHandlers(runner);

    expect(await runner.processBatch()).toBe(1);

    expect(
      await owner.backgroundJob.findUniqueOrThrow({
        where: { id: accepted.json().jobId },
      }),
    ).toMatchObject({ status: "SUCCEEDED" });
    expect(
      await owner.deliveryEvent.count({
        where: {
          businessId: CARRIER,
          OR: [{ device: { not: null } }, { device_id: { not: null } }],
        },
      }),
    ).toBe(0);
    expect(
      await owner.driver.findUniqueOrThrow({ where: { id: fleet.driverId } }),
    ).toMatchObject({ name: "Motorista removido", status: "INACTIVE" });
  });
});

describe("the boot's check of the role, on the real database", () => {
  it("lets the cut through with DATABASE_REQUIRE_RUNTIME_ROLE=true", async () => {
    const { verifyRuntimeRole } =
      await import("@/shared/database/runtime-role-check");
    const database = await import("@/../infra/database");

    await expect(
      verifyRuntimeRole({
        client: database.default,
        require: true,
        runsCron: true,
        batchUrl: urlAs(BATCH_LOGIN),
      }),
    ).resolves.toEqual({ fatal: [], warnings: [] });
  });

  it("refuses the owner, and a batch URL that is the request login", async () => {
    const { verifyRuntimeRole } =
      await import("@/shared/database/runtime-role-check");
    const database = await import("@/../infra/database");

    await expect(
      verifyRuntimeRole({
        client: owner,
        require: true,
        runsCron: false,
        batchUrl: undefined,
      }),
    ).rejects.toThrow("superusuário");

    await expect(
      verifyRuntimeRole({
        client: database.default,
        require: true,
        runsCron: true,
        batchUrl: urlAs(HTTP_LOGIN),
      }),
    ).rejects.toThrow("não consegue SET ROLE trajetto_partitions");
  });
});
