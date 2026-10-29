import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { ODOMETER_UNIT_KEY } from "@/shared/ai/ai-rules";

import { FakeProvider } from "./support/fake-provider";
import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import {
  startPipelineReplica,
  type PipelineReplica,
} from "./support/pipeline-replica-process";
import {
  expireLeases,
  openWork,
  publishAccountPayables,
  publishRouteReleases,
  queueWebhookRows,
  seedResilienceTenant,
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Cases A and E of contract §11 with a real crash: the provider ACCEPTED the
 * call, and the replica died (SIGKILL — no `finally`, no shutdown hook)
 * before the database recorded it. The lease runs out, another replica takes
 * the row over, and the question is the one §10 asks: does the retry create
 * a duplicate?
 *
 * The answer differs per provider, and this file pins each one down:
 *
 *  - e-mail: the retry goes out again, under the SAME Resend-Idempotency-Key
 *    (the delivery id) — Resend drops it, one message in the inbox;
 *  - webhook: posted again with the SAME X-Trajetto-Event-Id — the receiver
 *    deduplicates (documented contract, ADR 0006);
 *  - WhatsApp and push: posted again. Meta and Expo offer no key, so the
 *    recipient may see a WhatsApp twice; the copies carry the same delivery
 *    id (biz_opaque_callback_data / data.deliveryId), which is what the
 *    provider-receipt ledger counts (ADR 0003, OUTBOX-07). At-least-once.
 *    A push also carries that id as its `tag` (and `collapseId` on an
 *    iPhone), so the device replaces the first copy with the second instead
 *    of showing both.
 *  - AI (local OCR): read again — the local service costs nothing per call —
 *    and the photo's unit and the company's quota are spent exactly once.
 *
 * Nothing may stay PROCESSING, and the duplicate window is bounded by what
 * was on the wire when the process died — never the whole batch.
 */
const prisma = createPrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe600-0000-7000-8000-0000000000a1";
const AI_BUSINESS = "018fe600-0000-7000-8000-0000000000b1";

let seed: ResilienceSeed;
let fleet: FleetDriverSeed;
let periodId = "";
const replicas: PipelineReplica[] = [];

async function replica(
  workers: Array<"notifications" | "webhooks" | "ai">,
): Promise<PipelineReplica> {
  const started = await startPipelineReplica({
    fakeProviderUrl: fake.url,
    workers,
  });

  replicas.push(started);

  return started;
}

async function rowsOf(channel: string) {
  return prisma.notificationDelivery.findMany({
    where: { channel: channel as never },
  });
}

beforeAll(async () => {
  await fake.listen();
  seed = await seedResilienceTenant(prisma, BUSINESS);

  fleet = await seedFleetDriver(prisma, {
    businessId: AI_BUSINESS,
    cnpj: "62777999000190",
  });
  await prisma.business.update({
    where: { id: AI_BUSINESS },
    data: { ai_analysis_limit: 1000 },
  });

  periodId = (
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: AI_BUSINESS,
        periodStart: quotaPeriodFor(new Date(), null).periodStart,
      },
    })
  ).id;
}, 120_000);

beforeEach(async () => {
  // A replica a case left running (the one that recovered the work) keeps
  // sweeping into the next case: it claims that case's rows under the slow
  // fake, and they show up as PROCESSING or as an attempt the case never
  // made. Every case starts the replicas it means to have.
  await Promise.allSettled(replicas.splice(0).map((started) => started.kill()));

  fake.reset();

  await prisma.webhookDelivery.deleteMany({});
  await prisma.webhookEndpoint.deleteMany({});
  await prisma.notificationProviderReceipt.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.aIAnalysisRequest.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "COMPLETED", leaseExpiresAt: null },
  });
});

afterAll(async () => {
  await Promise.allSettled(replicas.map((started) => started.kill()));
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

describe("a send the provider accepted, and the replica died before recording it (case A)", () => {
  it(
    "is sent again by the next owner, carrying the same identity, and nothing stays PROCESSING",
    { timeout: 300_000 },
    async () => {
      await publishAccountPayables(prisma, seed, 1);
      await publishRouteReleases(prisma, seed, 1);

      // The provider takes the call and the answer never comes back in time.
      for (const kind of ["email", "whatsapp", "push"] as const) {
        fake.behave(kind, () => ({ kind: "hold" }));
      }

      const first = await replica(["notifications"]);

      await fake.waitFor(
        () =>
          ["email", "whatsapp", "push"].every(
            (kind) => fake.callsOf(kind as never).length === 1,
          ),
        "os três provedores aceitarem a chamada",
      );

      await first.kill();

      for (const channel of ["EMAIL", "WHATSAPP", "PUSH"]) {
        const [row] = await rowsOf(channel);

        expect(`${channel}:${row.status}:${row.attempts}`).toBe(
          `${channel}:PROCESSING:1`,
        );
      }

      const firstRound = [...fake.calls];

      // The provider answers normally from now on (what it held, it answers to
      // a dead socket), and the lease runs out.
      fake.reset();
      for (const kind of ["email", "whatsapp", "push"] as const) {
        fake.behave(kind, () => ({ kind: "answer" }));
      }

      await expireLeases(prisma);
      await replica(["notifications"]);
      await waitUntilSettled(prisma, "a retomada depois do crash");

      for (const [kind, channel] of [
        ["email", "EMAIL"],
        ["whatsapp", "WHATSAPP"],
        ["push", "PUSH"],
      ] as const) {
        const [row] = await rowsOf(channel);

        expect(`${channel}:${row.status}:${row.attempts}`).toBe(
          `${channel}:DELIVERED:2`,
        );

        // The retry addresses the same message the provider already took.
        expect(
          firstRound
            .filter((call) => call.kind === kind)
            .map((call) => call.identity),
        ).toEqual([row.id]);
        expect(fake.callsOf(kind).map((call) => call.identity)).toEqual([
          row.id,
        ]);
      }

      // E-mail is the one provider that honours a key: both sends carry the
      // delivery id as Resend-Idempotency-Key, and Resend answers the second
      // without a second e-mail (24 h window).
      const [email] = await rowsOf("EMAIL");

      expect(
        [
          ...firstRound.filter((call) => call.kind === "email"),
          ...fake.callsOf("email"),
        ].map((call) => call.idempotencyKey),
      ).toEqual([email.id, email.id]);

      // Expo honours no key, but the tray does: both copies carry the
      // delivery id as tag, so the second replaces the first on the device.
      // The seeded phone is an Android: no collapseId, which FCM would turn
      // into a collapse_key and cap at four per offline phone.
      const [push] = await rowsOf("PUSH");

      const pushMessages = [
        ...firstRound.filter((call) => call.kind === "push"),
        ...fake.callsOf("push"),
      ].flatMap(
        (call) => call.body as Array<{ tag?: string; collapseId?: string }>,
      );

      expect(pushMessages.length).toBeGreaterThanOrEqual(2);
      expect([
        ...new Set(
          pushMessages.map((message) => `${message.tag}|${message.collapseId}`),
        ),
      ]).toEqual([`${push.id}|undefined`]);
    },
  );

  it(
    "re-posts a webhook with the same event id for the receiver to deduplicate",
    { timeout: 300_000 },
    async () => {
      const [rowId] = await queueWebhookRows(prisma, seed, fake.url, 1, 1);

      fake.behave("webhook", () => ({ kind: "hold" }));

      const first = await replica(["webhooks"]);

      await fake.waitFor(
        () => fake.callsOf("webhook").length === 1,
        "o receptor aceitar o webhook",
      );

      const firstEventId = fake.callsOf("webhook")[0].idempotencyKey;

      await first.kill();

      fake.reset();
      await expireLeases(prisma);
      await replica(["webhooks"]);
      await waitUntilSettled(prisma, "o webhook depois do crash");

      const row = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: rowId },
      });

      expect(`${row.status}:${row.attempts}`).toBe("DELIVERED:2");
      expect(firstEventId).toBeTruthy();
      expect(
        fake.callsOf("webhook").map((call) => call.idempotencyKey),
      ).toEqual([firstEventId]);
    },
  );

  it(
    "reads the photo again, and spends its unit and the quota once (local OCR)",
    { timeout: 300_000 },
    async () => {
      const photo = `odometerPhotos/${AI_BUSINESS}/${randomUUID()}.jpg`;

      const fuel = await prisma.fuel.create({
        data: {
          current_mileage: 1000,
          liters_amount: 50,
          price_per_liter: 6,
          total_amount: 300,
          odometer_photo: photo,
          odometer_ai_status: "pending",
          businessId: AI_BUSINESS,
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
          businessId: AI_BUSINESS,
          periodId,
          requestedById: fleet.driverUserId,
          input: { odometerPhotoPath: photo, reportedMileage: 1000 },
        },
      });

      await prisma.aIAnalysisUnit.create({
        data: { requestId: request.id, unitKey: ODOMETER_UNIT_KEY },
      });

      const before = await prisma.aIUsagePeriod.findUniqueOrThrow({
        where: { id: periodId },
      });

      await prisma.aIUsagePeriod.update({
        where: { id: periodId },
        data: { reservedUnits: { increment: 1 } },
      });

      fake.behave("ocr", () => ({ kind: "hold" }));

      const first = await replica(["ai"]);

      await fake.waitFor(
        () => fake.callsOf("ocr").length === 1,
        "o serviço de OCR receber a foto",
      );
      await first.kill();

      expect(
        (
          await prisma.aIAnalysisRequest.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("PROCESSING");

      fake.reset();
      await expireLeases(prisma);
      await replica(["ai"]);
      await waitUntilSettled(prisma, "a leitura depois do crash");

      const settled = await prisma.aIAnalysisRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { units: true },
      });

      expect(settled.status).toBe("COMPLETED");
      expect(settled.attempts).toBe(2);
      expect(settled.units.map((unit) => unit.status)).toEqual(["CONSUMED"]);
      expect(fake.callsOf("ocr")).toHaveLength(1);

      const after = await prisma.aIUsagePeriod.findUniqueOrThrow({
        where: { id: periodId },
      });

      expect(after.consumedUnits - before.consumedUnits).toBe(1);
      expect(after.reservedUnits).toBe(before.reservedUnits);

      const record = await prisma.fuel.findUniqueOrThrow({
        where: { id: fuel.id },
      });

      expect(record.odometer_ai_status).not.toBe("pending");
    },
  );
});

describe("a replica killed in the middle of a batch (case E)", () => {
  it(
    "duplicates only what was on the wire, under the same key, and recovers the rest once",
    { timeout: 300_000 },
    async () => {
      await publishAccountPayables(prisma, seed, 20);

      // Every e-mail is held: the first wave of the batch is on the wire, the
      // rest of the batch is claimed behind it and never started.
      fake.behave("email", () => ({ kind: "hold" }));
      fake.behave("whatsapp", () => ({ kind: "hold" }));

      const first = await replica(["notifications"]);

      await fake.waitFor(
        () => fake.calls.length >= 5,
        "a primeira leva chegar ao provedor",
      );

      // Let the replica settle into the wait: whatever it put on the wire by
      // now is the in-flight window.
      await new Promise((done) => setTimeout(done, 500));
      await first.kill();

      const onTheWire = new Set(fake.calls.map((call) => call.identity));
      const external = [
        ...(await rowsOf("EMAIL")),
        ...(await rowsOf("WHATSAPP")),
      ];

      expect(external).toHaveLength(40);
      // Claimed but not started is the bulk of the batch, not the wire.
      expect(onTheWire.size).toBeLessThan(
        external.filter((row) => row.status === "PROCESSING").length,
      );

      fake.reset();
      await expireLeases(prisma);
      await replica(["notifications"]);
      await waitUntilSettled(prisma, "a retomada do lote");

      const settled = [
        ...(await rowsOf("EMAIL")),
        ...(await rowsOf("WHATSAPP")),
      ];

      expect(settled.filter((row) => row.status !== "DELIVERED")).toEqual([]);

      // Every message reached the provider; the ones that reached it twice are
      // exactly the ones in flight at the crash — and the e-mails among them
      // carried their key both times.
      const secondRound = fake.calls.map((call) => call.identity);

      expect(new Set(secondRound).size).toBe(secondRound.length);

      for (const row of settled) {
        const times =
          (onTheWire.has(row.id) ? 1 : 0) +
          secondRound.filter((id) => id === row.id).length;

        expect(times, `${row.channel} ${row.id}`).toBeLessThanOrEqual(
          onTheWire.has(row.id) ? 2 : 1,
        );
        expect(times, `${row.channel} ${row.id}`).toBeGreaterThanOrEqual(1);
      }

      for (const call of fake.callsOf("email")) {
        expect(call.idempotencyKey).toBe(call.identity);
      }
    },
  );

  it(
    "closes a row whose LAST allowed attempt died with the process, instead of sending it again",
    { timeout: 300_000 },
    async () => {
      await publishAccountPayables(prisma, seed, 1);

      fake.behave("email", () => ({ kind: "hold" }));

      const first = await replica(["notifications"]);

      await fake.waitFor(
        () => fake.callsOf("email").length === 1,
        "o e-mail chegar ao provedor",
      );
      await first.kill();

      // As if this had been the seventh claim (DELIVERY_MAX_ATTEMPTS).
      await prisma.notificationDelivery.updateMany({
        where: { channel: "EMAIL" },
        data: { attempts: 7 },
      });

      fake.reset();
      await expireLeases(prisma);
      await replica(["notifications"]);
      await waitUntilSettled(prisma, "o fechamento da última tentativa");

      const [email] = await rowsOf("EMAIL");

      expect(email.status).toBe("FAILED");
      expect(email.lastError).toContain("última tentativa permitida");
      expect(fake.callsOf("email")).toEqual([]);
    },
  );
});

describe("a deploy (graceful stop) in the middle of a batch", () => {
  it(
    "records what was in flight before exiting, so the next replica finds nothing to recover",
    { timeout: 300_000 },
    async () => {
      await publishAccountPayables(prisma, seed, 10);

      // Slow but answering: the stop arrives with sends in flight.
      fake.behave("email", () => ({ kind: "delay", ms: 1_200 }));
      fake.behave("whatsapp", () => ({ kind: "delay", ms: 1_200 }));

      const first = await replica(["notifications"]);

      await fake.waitFor(() => fake.calls.length >= 1, "o primeiro envio sair");
      await first.stop();

      // No lease expiry here: anything left PROCESSING would wait 180 s.
      const left = await openWork(prisma);

      expect(left.notification_delivery.processing).toBe(0);
      expect(left.domain_outbox_event.processing).toBe(0);

      const sentBefore = fake.calls.length;

      await replica(["notifications"]);
      await waitUntilSettled(prisma, "a nova réplica depois do deploy", 60_000);

      expect(fake.repeated("email")).toEqual([]);
      expect(fake.repeated("whatsapp")).toEqual([]);
      expect(fake.calls.length).toBe(20);
      expect(sentBefore).toBeGreaterThan(0);
    },
  );
});
