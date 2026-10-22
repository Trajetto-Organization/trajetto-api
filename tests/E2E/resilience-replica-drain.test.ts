import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { quotaPeriodFor } from "@/shared/ai/ai-period";

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
  publishAccountPayables,
  publishRouteReleases,
  queueFuelReadings,
  queueWebhookRows,
  seedResilienceTenant,
  waitUntilSettled,
  type ResilienceSeed,
} from "./support/resilience-seed";

/**
 * Case F of contract §11, with real processes: 3, 5 and 10 replicas drain
 * one backlog at the same time — outbox expansion, the two delivery lanes
 * (bell, activity, e-mail, WhatsApp, push), the webhook queue and the AI
 * readings (local OCR) — and every effect happens exactly once.
 *
 * queue-claim-concurrency.test.ts proves SKIP LOCKED with service instances
 * inside one process. This is the property a customer feels, measured where
 * it lives: separate processes, each with its own Prisma pool, timers, wake
 * chain and in-memory guards, racing on the same Postgres. The provider
 * effects are counted at the fake provider (another process), never on our
 * own rows: "sent twice" is the failure, and our rows cannot see it.
 */
const prisma = new PrismaClient();
const fake = new FakeProvider();

const BUSINESS = "018fe500-0000-7000-8000-0000000000a1";
const AI_BUSINESS = "018fe500-0000-7000-8000-0000000000b1";

let fleet: FleetDriverSeed;
let periodId = "";

let seed: ResilienceSeed;
let replicas: PipelineReplica[] = [];

const REPLICA_COUNTS = (process.env.RESILIENCE_REPLICAS ?? "3,5,10")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => value > 0);

beforeAll(async () => {
  await fake.listen();
  seed = await seedResilienceTenant(prisma, BUSINESS);

  fleet = await seedFleetDriver(prisma, {
    businessId: AI_BUSINESS,
    cnpj: "62777999000352",
  });
  await prisma.business.update({
    where: { id: AI_BUSINESS },
    data: { ai_analysis_limit: 100_000 },
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
  fake.reset();

  await prisma.webhookDelivery.deleteMany({});
  await prisma.webhookEndpoint.deleteMany({});
  await prisma.notificationProviderReceipt.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.activity.deleteMany({});
});

afterAll(async () => {
  await Promise.allSettled(replicas.map((replica) => replica.kill()));
  await fake.close();
  await prisma.$disconnect();
}, 60_000);

describe.each(REPLICA_COUNTS)(
  "%i replicas draining one backlog at once",
  (count) => {
    it(
      "deliver every notification and webhook exactly once",
      { timeout: 600_000 },
      async () => {
        // Every replica up and idle FIRST, then the backlog: booting a replica
        // takes seconds, and a backlog queued before would be drained by
        // whichever process came up first — "N replicas" in name only. Each
        // provider answers after a short delay so the drain spans several
        // sweeps of every replica.
        replicas = await Promise.all(
          Array.from({ length: count }, () =>
            startPipelineReplica({
              fakeProviderUrl: fake.url,
              workers: ["notifications", "webhooks", "ai"],
            }),
          ),
        );

        for (const kind of [
          "email",
          "whatsapp",
          "push",
          "webhook",
          "ocr",
        ] as const) {
          fake.behave(kind, () => ({ kind: "delay", ms: 100 }));
        }

        const accountPayables = await publishAccountPayables(prisma, seed, 30);
        const releases = await publishRouteReleases(prisma, seed, 20);
        const webhookRows = await queueWebhookRows(
          prisma,
          seed,
          fake.url,
          4,
          15,
        );

        expect(webhookRows).toHaveLength(60);

        // Read before queuing: the replicas start reading as soon as it lands.
        const ledgerBefore = await prisma.aIUsagePeriod.findUniqueOrThrow({
          where: { id: periodId },
        });
        const readings = await queueFuelReadings(prisma, fleet, periodId, 20);

        try {
          await waitUntilSettled(prisma, `${count} réplicas`, 240_000);
        } finally {
          await Promise.allSettled(replicas.map((replica) => replica.stop()));
          replicas = [];
        }

        // Every event expanded once, every delivery and webhook settled on its
        // first attempt: a second claim of anything moves `attempts`.
        const events = await prisma.domainOutboxEvent.findMany();

        expect(events).toHaveLength(accountPayables.length + releases.length);
        expect(
          events.filter(
            (event) => event.status !== "PUBLISHED" || event.attempts !== 1,
          ),
        ).toEqual([]);

        const deliveries = await prisma.notificationDelivery.findMany();
        const notFirstTime = deliveries.filter(
          (row) => row.status !== "DELIVERED" || row.attempts !== 1,
        );

        expect(
          notFirstTime.map(
            (row) =>
              `${row.channel}:${row.status}:${row.attempts}:${row.lastError}`,
          ),
        ).toEqual([]);

        const byChannel = (channel: string) =>
          deliveries.filter((row) => row.channel === channel);

        // The channel set the policies promise, so a silent drop of a whole
        // channel cannot pass as "nothing duplicated".
        expect(byChannel("EMAIL")).toHaveLength(accountPayables.length);
        expect(byChannel("WHATSAPP")).toHaveLength(accountPayables.length);
        expect(byChannel("IN_APP")).toHaveLength(accountPayables.length);
        expect(byChannel("PUSH")).toHaveLength(releases.length);

        // What the outside world received: once each, under its own identity.
        for (const [kind, channel] of [
          ["email", "EMAIL"],
          ["whatsapp", "WHATSAPP"],
          ["push", "PUSH"],
        ] as const) {
          expect(fake.repeated(kind), `${kind} repetido`).toEqual([]);
          expect(
            fake
              .callsOf(kind)
              .map((call) => call.identity)
              .sort(),
          ).toEqual(
            byChannel(channel)
              .map((row) => row.id)
              .sort(),
          );
        }

        expect(fake.repeated("webhook"), "webhook repetido").toEqual([]);
        expect(fake.callsOf("webhook")).toHaveLength(60);

        const webhooks = await prisma.webhookDelivery.findMany();

        expect(
          webhooks.filter(
            (row) => row.status !== "DELIVERED" || row.attempts !== 1,
          ),
        ).toEqual([]);

        // The AI: every photo read once, its unit and the quota spent once.
        const requests = await prisma.aIAnalysisRequest.findMany({
          where: { id: { in: readings.map((reading) => reading.requestId) } },
          include: { units: true },
        });

        // Read once, on the first attempt; anything else names its reason
        // (lastError), so a red run says why without the replicas' logs.
        expect(requests).toHaveLength(20);
        expect(
          requests
            .filter(
              (request) =>
                request.status !== "COMPLETED" || request.attempts !== 1,
            )
            .map(
              (request) =>
                `${request.id}:${request.status}:${request.attempts}:${request.lastError}`,
            ),
        ).toEqual([]);
        expect(
          requests.flatMap((request) =>
            request.units.map((unit) => unit.status),
          ),
        ).toEqual(Array(20).fill("CONSUMED"));
        expect(fake.callsOf("ocr")).toHaveLength(20);

        const ledgerAfter = await prisma.aIUsagePeriod.findUniqueOrThrow({
          where: { id: periodId },
        });

        expect(ledgerAfter.consumedUnits - ledgerBefore.consumedUnits).toBe(20);
        // Each queued reading reserved one unit, and each was spent: net zero.
        expect(ledgerAfter.reservedUnits).toBe(ledgerBefore.reservedUnits);

        // The work was really shared: several processes served calls of every
        // pipeline. Without this a replica that booted first and drained
        // everything alone would pass every assertion above.
        // (The tag is the pid of the process running the app — tsx's child —
        // not the launcher's, so it is counted, not matched.)
        expect(
          fake.calls.filter((call) => call.replica === null),
          "chamada sem réplica",
        ).toEqual([]);
        expect(fake.replicasServing().size).toBeLessThanOrEqual(count);
        expect(
          fake.replicasServing().size,
          "réplicas distintas atendendo",
        ).toBeGreaterThanOrEqual(Math.min(count, 3));

        for (const kinds of [
          ["email", "whatsapp", "push"],
          ["webhook"],
          ["ocr"],
        ] as const) {
          expect(
            fake.replicasServing(...kinds).size,
            `réplicas distintas em ${kinds.join("/")}`,
          ).toBeGreaterThanOrEqual(2);
        }

        // The bell: one notification per IN_APP delivery, never two.
        const bells = await prisma.notification.findMany({
          where: { userId: seed.adminId },
        });

        expect(bells).toHaveLength(accountPayables.length);
      },
    );
  },
);
