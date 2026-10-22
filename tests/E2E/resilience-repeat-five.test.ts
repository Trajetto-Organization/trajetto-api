import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";

/**
 * Contract §10, first question, asked literally of every write the app and
 * the panel repeat: "if the request is repeated exactly five times, what is
 * the result?" — five copies AT ONCE (the offline outbox flushing on a flaky
 * network, a double tap, a retry racing a slow first answer), then five more
 * one after the other (the outbox replaying after lost answers).
 *
 * The other suites prove each flow with two copies. Two copies have one
 * loser; five have four, racing each other as well as the winner, through
 * every window the use case has (pre-check, guard, unique index). What must
 * hold for every flow:
 *
 *  - never a 5xx (a 500 makes the app retry what already exists, and shows
 *    the driver an error for something that worked);
 *  - never a 409 between copies of the SAME submission (409 is reserved for
 *    a real conflict, ADR 0006 IDEMP-07);
 *  - one record, one domain event, one webhook row: the effect happened once.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let fleet: FleetDriverSeed;
let uploads: UploadService;

const CARRIER = "018fe900-0000-7000-8000-0000000005a1";

const TOWER_TYPE = "018fe900-0000-7000-8000-0000000005e1";

let shipperId = "";
let routeId = "";
let stopSequence = 0;

const storedKeys: string[] = [];

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function send(
  method: "POST" | "PATCH",
  url: string,
  token: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload,
  });

  return { status: response.statusCode, body: response.json() };
}

/** Five copies at once, then five one after the other. */
async function fiveAndFive(request: () => Promise<Answer>): Promise<Answer[]> {
  const burst = await Promise.all(Array.from({ length: 5 }, () => request()));
  const replays: Answer[] = [];

  for (let copy = 0; copy < 5; copy += 1) replays.push(await request());

  return [...burst, ...replays];
}

/** Status and code of every answer that is not a success. */
function refusals(answers: Answer[]): string[] {
  return answers
    .filter((answer) => answer.status >= 300)
    .map(
      (answer) =>
        `${answer.status} ${answer.body?.code ?? ""} ${answer.body?.message ?? ""}`,
    );
}

async function storedPhoto(
  kind: "odometerPhotos" | "deliveryPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${kind}/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryInTransit(recipient: string): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: recipient,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      invoice_number: "4511",
      businessId: CARRIER,
      shipperId,
      driverId: fleet.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

/** A stop of the driver's running route, for the delivery. */
async function stopFor(deliveryId: string): Promise<string> {
  stopSequence += 10;

  const stop = await prisma.routeStop.create({
    data: { routeId, deliveryId, sequence: stopSequence },
  });

  return stop.id;
}

async function typeId(systemKey: string): Promise<string> {
  return (
    await prisma.occurrenceType.findUniqueOrThrow({
      where: {
        businessId_system_key: { businessId: CARRIER, system_key: systemKey },
      },
    })
  ).id;
}

const outboxCount = (aggregateId: string, topic: string) =>
  prisma.domainOutboxEvent.count({ where: { aggregateId, topic } });

async function webhookRows(deliveryId: string, topic: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM "webhook_delivery"
     WHERE "businessId" = ${CARRIER} AND "topic" = ${topic}
       AND "payload"::text LIKE ${`%${deliveryId}%`}
  `;

  return Number(rows[0].count);
}

beforeAll(async () => {
  fleet = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "47888999000150",
  });

  await ensureDefaultOccurrenceTypes(prisma, CARRIER);

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
    })
  ).id;

  await prisma.occurrenceType.create({
    data: {
      id: TOWER_TYPE,
      name: "Cliente ausente (torre)",
      blocks_delivery: true,
      requires_authorization: true,
      businessId: CARRIER,
    },
  });

  // Somebody's ERP: every webhook row is an effect to count.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhook",
      secret: "segredo-do-teste",
      businessId: CARRIER,
      topics: ["delivery.*", "occurrence.*", "proof.*", "route.*"],
    },
  });

  // On the street: pauses need a journey (decision 14.4) and the stops a route.
  routeId = await seedJourneyRoute(prisma, CARRIER, fleet.driverId);

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the same request, five at once and five more after", () => {
  it(
    "an occurrence that needs the tower: one occurrence, one ticket, one event",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Ocorrência repetida");
      const body = {
        occurrenceTypeId: TOWER_TYPE,
        client_submission_id: randomUUID(),
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
          fleet.driverToken,
          body,
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body.data.id)).size).toBe(
        1,
      );
      expect(
        answers.filter((answer) => answer.body.data.replayed === false),
      ).toHaveLength(1);

      expect(
        await prisma.deliveryOccurrence.count({ where: { deliveryId } }),
      ).toBe(1);
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "OCCURRENCE" },
        }),
      ).toBe(1);
      expect(await prisma.supportTicket.count({ where: { deliveryId } })).toBe(
        1,
      );
    },
  );

  it(
    "the tower's decision, sent five times by the same operator: one decision, one effect",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Decisão repetida");
      const reported = await send(
        "POST",
        `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
        fleet.driverToken,
        { occurrenceTypeId: TOWER_TYPE, client_submission_id: randomUUID() },
      );

      expect(reported.status).toBe(201);

      const occurrenceId = reported.body.data.id as string;

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/occurrence-authorization/${occurrenceId}/business/${CARRIER}`,
          fleet.managerToken,
          { decision: "APPROVED", note: "Pode voltar." },
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        answers.filter((answer) => answer.body.data.replayed === false),
      ).toHaveLength(1);

      expect(
        await outboxCount(
          deliveryId,
          "delivery-occurrence.authorization_decided",
        ),
      ).toBe(1);
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "STATUS_CHANGE" },
        }),
      ).toBe(1);
      expect(await webhookRows(deliveryId, "delivery.failed")).toBe(1);
    },
  );

  it(
    "a proof of delivery: one occurrence, one PROOF event, one audit card, announced once",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Comprovante repetido");
      const body = {
        occurrenceTypeId: await typeId("delivered_default"),
        client_submission_id: randomUUID(),
        receipt_photo: await storedPhoto("deliveryPhotos"),
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
          fleet.driverToken,
          body,
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body.data.id)).size).toBe(
        1,
      );

      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "PROOF" },
        }),
      ).toBe(1);
      expect(
        await prisma.deliveryProofAudit.count({ where: { deliveryId } }),
      ).toBe(1);
      expect(await webhookRows(deliveryId, "delivery.delivered")).toBe(1);
      expect(await webhookRows(deliveryId, "proof.registered")).toBe(1);
    },
  );

  it(
    "a proof through the installed app's legacy route: one PROOF event, one card",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Comprovante legado repetido");
      const body = {
        client_submission_id: randomUUID(),
        received_by: "Maria Souza",
        photo: await storedPhoto("deliveryPhotos"),
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/proof/${deliveryId}/business/${CARRIER}`,
          fleet.driverToken,
          body,
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "PROOF" },
        }),
      ).toBe(1);
      expect(
        await prisma.deliveryProofAudit.count({ where: { deliveryId } }),
      ).toBe(1);
      expect(await webhookRows(deliveryId, "delivery.delivered")).toBe(1);
    },
  );

  it(
    "a stop marked on the way: one event, one message to the customer at most",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("A caminho repetido");
      const stopId = await stopFor(deliveryId);
      const body = { client_submission_id: randomUUID() };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/route/on-the-way/${stopId}/route/${routeId}/business/${CARRIER}`,
          fleet.driverToken,
          body,
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "ON_THE_WAY" },
        }),
      ).toBe(1);
      expect(
        await outboxCount(deliveryId, "delivery.on_the_way"),
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "an arrival at the address: one ARRIVAL event",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Chegada repetida");
      const key = randomUUID();
      const body = {
        client_submission_id: key,
        latitude: -23.55,
        longitude: -46.63,
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/arrival/${deliveryId}/business/${CARRIER}`,
          fleet.driverToken,
          body,
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        await prisma.deliveryEvent.count({
          where: { client_submission_id: key },
        }),
      ).toBe(1);
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "ARRIVAL" },
        }),
      ).toBe(1);
    },
  );

  it(
    "a pause started and ended: one pause, closed once",
    { timeout: 60_000 },
    async () => {
      const start = { kind: "MEAL", start_submission_id: randomUUID() };

      const started = await fiveAndFive(() =>
        send(
          "POST",
          `/driver-pause/start/${CARRIER}`,
          fleet.driverToken,
          start,
        ),
      );

      expect(refusals(started)).toEqual([]);
      expect(started.filter((answer) => answer.status === 201)).toHaveLength(1);
      expect(new Set(started.map((answer) => answer.body.pause.id)).size).toBe(
        1,
      );

      const end = {
        start_submission_id: start.start_submission_id,
        end_submission_id: randomUUID(),
      };

      const ended = await fiveAndFive(() =>
        send("POST", `/driver-pause/end/${CARRIER}`, fleet.driverToken, end),
      );

      expect(refusals(ended)).toEqual([]);

      const pauses = await prisma.driverPause.findMany({
        where: { driverId: fleet.driverId },
      });

      expect(pauses).toHaveLength(1);
      expect(pauses[0].ended_at).not.toBeNull();
    },
  );

  it(
    "a fueling: one record, the odometer moved once",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const vehicle = await prisma.vehicle.findUniqueOrThrow({
        where: { id: fleet.vehicleId },
      });
      const mileage = vehicle.current_mileage + 100;

      const body = {
        client_submission_id: key,
        current_mileage: mileage,
        liters_amount: 50,
        price_per_liter: 6.5,
        total_amount: 325,
        refueling_date: new Date(Date.now() - 60_000).toISOString(),
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
        fuelTypeId: fleet.fuelTypeId,
        branchId: fleet.branchId,
        businessId: CARRIER,
        latitude: -23.55,
        longitude: -46.63,
        created_from: "MOBILE_APP",
        photo: { key: await storedPhoto("odometerPhotos") },
      };

      const answers = await fiveAndFive(() =>
        send("POST", `/fuel/create-fuel/${CARRIER}`, fleet.driverToken, body, {
          "idempotency-key": key,
        }),
      );

      expect(refusals(answers)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
      expect(
        await prisma.fuel.count({ where: { client_submission_id: key } }),
      ).toBe(1);
      expect(
        (
          await prisma.vehicle.findUniqueOrThrow({
            where: { id: fleet.vehicleId },
          })
        ).current_mileage,
      ).toBe(mileage);
    },
  );

  it(
    "a support ticket opened by the driver: one ticket",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Atendimento repetido");
      const key = randomUUID();

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          "/chat/tickets",
          fleet.driverToken,
          { deliveryId },
          { "idempotency-key": key },
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body.data.id)).size).toBe(
        1,
      );
      expect(
        answers.filter((answer) => answer.body.created === true),
      ).toHaveLength(1);
      expect(await prisma.supportTicket.count({ where: { deliveryId } })).toBe(
        1,
      );
    },
  );

  it(
    "a delivery created from the panel with the form's key: one delivery, announced once",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const body = {
        shipperId,
        recipient_name: `Painel ${key.slice(0, 8)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/delivery/create-delivery/${CARRIER}`,
          fleet.managerToken,
          body,
          { "idempotency-key": key },
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body.data.id)).size).toBe(
        1,
      );

      const deliveryId = answers[0].body.data.id as string;

      expect(
        await prisma.delivery.count({
          where: { businessId: CARRIER, recipient_name: body.recipient_name },
        }),
      ).toBe(1);
      expect(await webhookRows(deliveryId, "delivery.created")).toBe(1);
    },
  );

  it("a checklist: one record", { timeout: 60_000 }, async () => {
    const key = randomUUID();
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: fleet.vehicleId },
    });

    const body = {
      client_submission_id: key,
      vehicleId: fleet.vehicleId,
      businessId: CARRIER,
      branchId: fleet.branchId,
      driverId: fleet.driverId,
      checklist_date: new Date(Date.now() - 60_000).toISOString(),
      current_mileage: vehicle.current_mileage + 10,
      created_from: "MOBILE_APP",
      headlights_working: true,
      taillights_working: true,
      turn_signals_working: true,
      seatbelts_working: true,
      dashboard_working: true,
      brakes_working: true,
      clutch_working: true,
      fuel_level_adequate: true,
      oil_level_adequate: true,
      radiator_water_adequate: true,
      brake_fluid_adequate: true,
      driver_license_valid: true,
      vehicle_documents_valid: true,
      insurance_valid: true,
      fire_extinguisher_valid: true,
      warning_triangle_present: true,
      jack_present: true,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      overall_condition: "approved",
      // The three photos the checklist form requires.
      photos: await Promise.all(
        ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
          async (fieldName) => ({
            key: await storedPhoto("checklistPhotos"),
            fieldName,
          }),
        ),
      ),
    };

    const answers = await fiveAndFive(() =>
      send(
        "POST",
        `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
        fleet.driverToken,
        body,
        {
          "idempotency-key": key,
        },
      ),
    );

    expect(refusals(answers)).toEqual([]);
    expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
    expect(
      await prisma.vehicleChecklist.count({
        where: { client_submission_id: key },
      }),
    ).toBe(1);
  });

  it(
    "a chat message from the driver: one message, one notice",
    { timeout: 60_000 },
    async () => {
      const text = `Mensagem repetida ${randomUUID().slice(0, 8)}`;
      const body = {
        driverIds: [fleet.driverId],
        kind: "TEXT",
        clientSubmissionId: randomUUID(),
        body: text,
      };

      const answers = await fiveAndFive(() =>
        send("POST", "/chat/send-message", fleet.driverToken, body),
      );

      expect(refusals(answers)).toEqual([]);

      const messages = await prisma.chatMessage.findMany({
        where: { body: text },
      });

      expect(messages).toHaveLength(1);
      expect(
        await prisma.domainOutboxEvent.count({
          where: { aggregateId: messages[0].id },
        }),
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "an account payable saved from the panel with the form's key: one bill, one notice",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const body = {
        category: "MAINTENANCE",
        due_date: "2026-11-10",
        amount: 321.5,
        branchId: fleet.branchId,
        registrationUserId: fleet.driverUserId,
        payee_name: "Oficina Repetida",
        document_number: `NF-${key.slice(0, 6)}`,
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/account-payable/create-account-payable/${CARRIER}`,
          fleet.managerToken,
          body,
          {
            "idempotency-key": key,
          },
        ),
      );

      expect(refusals(answers)).toEqual([]);

      const bills = await prisma.accountPayable.findMany({
        where: { businessId: CARRIER, document_number: body.document_number },
      });

      expect(bills).toHaveLength(1);
      expect(
        await prisma.domainOutboxEvent.count({
          where: { aggregateId: bills[0].id },
        }),
      ).toBe(1);
    },
  );

  it(
    "a route planned from the panel with the form's key: one route, one number",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const body = {
        driverId: fleet.driverId,
        scheduled_date: "2026-12-01",
        name: `Rota ${key.slice(0, 6)}`,
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/route/create-route/${CARRIER}`,
          fleet.managerToken,
          body,
          { "idempotency-key": key },
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        await prisma.route.count({
          where: { businessId: CARRIER, name: body.name },
        }),
      ).toBe(1);
    },
  );

  it(
    "an NF-e XML uploaded again and again: one delivery, announced once",
    { timeout: 120_000 },
    async () => {
      const accessKey = "35240611222333000181550010000077771000012345";
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>077771</nNF></ide>
      <emit><CNPJ>11222333000181</CNPJ><xNome>Indústria Repetida</xNome></emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Repetido</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr><nro>450</nro><xBairro>Centro</xBairro>
          <xMun>Campinas</xMun><UF>SP</UF><CEP>13010000</CEP>
        </enderDest>
      </dest>
      <det nItem="1">
        <prod><xProd>Caixa de leite</xProd><qCom>12.0000</qCom><uCom>CX</uCom><vUnCom>4.5000</vUnCom></prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>`;

      const answers = await fiveAndFive(() =>
        send("POST", `/delivery/import-xml/${CARRIER}`, fleet.managerToken, {
          files: [{ filename: "nota-repetida.xml", content: xml }],
        }),
      );

      // The five concurrent copies must all have been processed (no 429): a
      // limiter that refused them would leave one copy and prove nothing about
      // the race. Of the sequential replays a 429 is the import limiter (10 a
      // minute) doing its job, not a failure of the write.
      expect(refusals(answers.slice(0, 5))).toEqual([]);
      expect(
        refusals(answers).filter((line) => !line.startsWith("429")),
      ).toEqual([]);

      const deliveries = await prisma.delivery.findMany({
        where: { businessId: CARRIER, invoice_key: accessKey },
      });

      expect(deliveries).toHaveLength(1);
      expect(await webhookRows(deliveries[0].id, "delivery.created")).toBe(1);
    },
  );

  it(
    "a route departure resent by the outbox: one departure, one started_at, announced once",
    { timeout: 60_000 },
    async () => {
      // The journey route is on the street; another one in progress would make
      // this departure a real conflict (ROUTE_DRIVER_BUSY), not a resend.
      await prisma.route.update({
        where: { id: routeId },
        data: { status: "RELEASED", started_at: null },
      });

      try {
        const last = await prisma.route.aggregate({
          where: { businessId: CARRIER },
          _max: { code: true },
        });
        const route = await prisma.route.create({
          data: {
            code: Math.max((last._max.code ?? 0) + 1, 80_000),
            name: "Saída repetida",
            businessId: CARRIER,
            driverId: fleet.driverId,
            vehicleId: fleet.vehicleId,
            status: "RELEASED",
            scheduled_date: new Date(Date.UTC(2026, 9, 7)),
            released_at: new Date(Date.now() - 3_600_000),
          },
        });
        const loads = await Promise.all(
          ["Saída A", "Saída B"].map((recipient) =>
            prisma.delivery.create({
              data: {
                recipient_name: recipient,
                city: "São Paulo",
                uf: "SP",
                street: "Rua das Saídas",
                businessId: CARRIER,
                shipperId,
                driverId: fleet.driverId,
                status: "PENDING",
              },
            }),
          ),
        );

        await prisma.routeStop.createMany({
          data: loads.map((load, index) => ({
            routeId: route.id,
            deliveryId: load.id,
            sequence: (index + 1) * 10,
          })),
        });

        const answers = await fiveAndFive(() =>
          send(
            "POST",
            `/route/start-route/${route.id}/business/${CARRIER}`,
            fleet.driverToken,
            {},
          ),
        );

        // No 409 ROUTE_STATUS_CONFLICT between copies: the outbox would mark
        // a departure that happened as failed.
        expect(refusals(answers)).toEqual([]);

        const after = await prisma.route.findUniqueOrThrow({
          where: { id: route.id },
        });

        expect(after.status).toBe("IN_PROGRESS");
        // Every copy answers with the one departure the database holds.
        expect(answers.map((answer) => answer.body.data.started_at)).toEqual(
          Array(10).fill(after.started_at!.toISOString()),
        );

        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM "webhook_delivery"
         WHERE "businessId" = ${CARRIER} AND "topic" = 'route.started'
           AND "payload"::text LIKE ${`%${route.id}%`}
      `;

        expect(Number(rows[0].count)).toBe(1);

        for (const load of loads) {
          expect(
            await outboxCount(load.id, "delivery.dispatched"),
          ).toBeLessThanOrEqual(1);
          expect(
            (
              await prisma.delivery.findUniqueOrThrow({
                where: { id: load.id },
              })
            ).status,
          ).toBe("IN_TRANSIT");
        }

        // Back in the yard, so the journey route is the driver's again.
        await prisma.route.update({
          where: { id: route.id },
          data: { status: "COMPLETED", completed_at: new Date() },
        });
      } finally {
        await prisma.route.update({
          where: { id: routeId },
          data: {
            status: "IN_PROGRESS",
            started_at: new Date(Date.now() - 40 * 24 * 3_600_000),
          },
        });
      }
    },
  );

  it(
    "the legacy departure of loose deliveries: each moved once, the copies move nothing",
    { timeout: 60_000 },
    async () => {
      const loose = await Promise.all(
        ["Avulsa A", "Avulsa B", "Avulsa C"].map((recipient) =>
          prisma.delivery.create({
            data: {
              recipient_name: recipient,
              city: "São Paulo",
              uf: "SP",
              street: "Rua Avulsa",
              businessId: CARRIER,
              shipperId,
              driverId: fleet.driverId,
              status: "PENDING",
            },
          }),
        ),
      );

      const answers = await fiveAndFive(() =>
        send("POST", `/delivery/start-route/${CARRIER}`, fleet.driverToken, {}),
      );

      expect(refusals(answers)).toEqual([]);
      // Three loose deliveries, three moves in total across ten copies.
      expect(
        answers.reduce(
          (sum, answer) =>
            sum + Number(answer.body.started ?? answer.body.data?.started ?? 0),
          0,
        ),
      ).toBe(3);

      const moved = await prisma.delivery.findMany({
        where: { id: { in: loose.map((load) => load.id) } },
      });

      expect(moved.map((load) => load.status)).toEqual([
        "IN_TRANSIT",
        "IN_TRANSIT",
        "IN_TRANSIT",
      ]);
    },
  );

  it(
    "a ticket reopened five times by the operator: reopened once, one event",
    { timeout: 60_000 },
    async () => {
      const deliveryId = await deliveryInTransit("Reabertura repetida");
      const opened = await send(
        "POST",
        "/chat/tickets",
        fleet.managerToken,
        { deliveryId },
        { "idempotency-key": randomUUID() },
      );

      expect(opened.status, JSON.stringify(opened.body)).toBe(201);

      const ticketId = opened.body.data.id as string;
      const closed = await send(
        "POST",
        `/chat/tickets/${ticketId}/close`,
        fleet.managerToken,
        { outcome: "RESOLVED" },
      );

      expect(closed.status, JSON.stringify(closed.body)).toBe(200);

      const answers = await fiveAndFive(() =>
        send("POST", `/chat/tickets/${ticketId}/reopen`, fleet.managerToken, {
          note: "Cliente voltou a ligar.",
        }),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        answers.filter((answer) => answer.body.replayed === false),
      ).toHaveLength(1);
      expect(
        await prisma.supportTicketEvent.count({
          where: { ticketId, type: "REOPENED" },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.supportTicket.findUniqueOrThrow({
            where: { id: ticketId },
          })
        ).status,
      ).toBe("OPEN");
    },
  );

  it(
    "a fine saved from the panel with the form's key: one fine, one notice",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const code = await prisma.trafficViolationCode.create({
        data: {
          code: "7455",
          sub_code: 0,
          description:
            "Transitar em velocidade superior à máxima permitida em até 20%",
          legal_basis: "Art. 218, I",
          violator_type: "Condutor",
          gravity: "MEDIUM",
          gravity_raw: "Média",
          points: 4,
          competent_agency: "Estadual",
        },
      });
      const body = {
        violation_date: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        due_date: new Date(Date.now() + 27 * 86_400_000).toISOString(),
        amount: "293,47",
        branchId: fleet.branchId,
        driverId: fleet.driverId,
        vehicleId: fleet.vehicleId,
        trafficViolationCodeId: code.id,
        created_from: "WEB_DASHBOARD",
        observation: `Multa repetida ${key.slice(0, 8)}`,
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/fines/create-fine/${CARRIER}`,
          fleet.managerToken,
          body,
          { "idempotency-key": key },
        ),
      );

      expect(refusals(answers)).toEqual([]);

      const fines = await prisma.fine.findMany({
        where: { businessId: CARRIER, observation: body.observation },
      });

      expect(fines).toHaveLength(1);
      expect(
        await prisma.domainOutboxEvent.count({
          where: { aggregateId: fines[0].id },
        }),
      ).toBe(1);
    },
  );

  it(
    "a service order saved from the panel with the form's key: one order",
    { timeout: 60_000 },
    async () => {
      const key = randomUUID();
      const manager = await prisma.user.findFirstOrThrow({
        where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
      });
      const vehicle = await prisma.vehicle.findUniqueOrThrow({
        where: { id: fleet.vehicleId },
      });
      const body = {
        date: new Date(Date.now() - 60_000).toISOString(),
        maintenance_type: "INTERNAL",
        total_amount: 777.77,
        current_mileage_at_service: Math.max(vehicle.current_mileage, 20_000),
        maintenance_interval_km_at_service: 10_000,
        last_maintenance_mileage_at_service:
          Math.max(vehicle.current_mileage, 20_000) - 10_000,
        vehicleId: fleet.vehicleId,
        responsibleUserId: manager.id,
        branchId: fleet.branchId,
        created_from: "WEB_DASHBOARD",
        description: `Ordem repetida ${key.slice(0, 8)}`,
      };

      const answers = await fiveAndFive(() =>
        send(
          "POST",
          `/service-order/create-service-order/${CARRIER}`,
          fleet.managerToken,
          body,
          {
            "idempotency-key": key,
          },
        ),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        await prisma.serviceOrder.count({
          where: { businessId: CARRIER, description: body.description },
        }),
      ).toBe(1);
    },
  );

  it(
    "a batch of positions: stored once, the copies say nothing was new",
    { timeout: 60_000 },
    async () => {
      const base = Date.now() - 60_000;
      const pings = [0, 1, 2].map((index) => ({
        latitude: -23.55 + index * 0.0001,
        longitude: -46.63 + index * 0.0001,
        accuracy: 10,
        speed: 30,
        heading: 90,
        battery: 80,
        recorded_at: new Date(base + index * 5_000).toISOString(),
      }));

      const answers = await fiveAndFive(() =>
        send("POST", "/route/positions", fleet.driverToken, { pings }),
      );

      expect(refusals(answers)).toEqual([]);
      expect(
        answers.reduce(
          (sum, answer) => sum + Number(answer.body.data?.stored ?? 0),
          0,
        ),
      ).toBe(3);
      expect(
        await prisma.driverPosition.count({
          where: { driverId: fleet.driverId },
        }),
      ).toBe(3);
    },
  );
});
